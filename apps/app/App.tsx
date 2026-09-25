import { StatusBar } from "expo-status-bar";
import { Stack, router, usePathname } from "expo-router";
import { getLocales } from "expo-localization";
import * as Crypto from "expo-crypto";
import NetInfo from "@react-native-community/netinfo";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Appearance,
  FlatList,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  Vibration,
  View,
} from "react-native";
import {
  ReminderService,
  filterReminders,
  type SyncConflict,
} from "@cron-reminder/application";
import { exportBackup, importBackup } from "@cron-reminder/infrastructure";
import {
  describeSchedule,
  nextOccurrences,
  validateCronExpression,
  validateSchedule,
  type Reminder,
  type ReminderSound,
  type Schedule,
} from "@cron-reminder/domain";
import {
  createTranslator,
  normalizeLocale,
  type Locale,
} from "@cron-reminder/localization";
import {
  authentication,
  deleteReminder,
  flushPendingDeviceDeregistrations,
  flushNotificationActions,
  flushPendingPushTokenUpdate,
  getRememberedDeviceRegistration,
  localRepository,
  rememberDevice,
  resolveSynchronizationConflict,
  runReminderMutation,
  submitNotificationAction,
  supabase,
  synchronizeReminders,
  updateRememberedDeviceToken,
} from "./src/services";
import {
  DeviceNotificationAdapter,
  subscribeToPushTokenChanges,
} from "./src/notificationAdapter";

type ThemePreference = "system" | "light" | "dark";
type EditorKind =
  | "once"
  | "interval"
  | "daily"
  | "weekdays"
  | "monthly"
  | "yearly"
  | "advanced";

const service = new ReminderService(
  localRepository,
  { now: () => new Date() },
  () => `reminder-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

interface AppContextValue {
  ownerId: string;
  syncRevision: number;
  backgroundSyncConflicts: readonly SyncConflict[];
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  colors: Colors;
}

const AppContext = createContext<AppContextValue | null>(null);
const navigationItems = [
  { key: "reminders", path: "/" },
  { key: "history", path: "/history" },
  { key: "settings", path: "/settings" },
] as const;

function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error("App context is unavailable.");
  return context;
}

export default function App() {
  return <RootNavigator />;
}

export function RootNavigator() {
  const systemTheme = useColorScheme() ?? "light";
  const { width } = useWindowDimensions();
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [locale, setLocale] = useState<Locale>(
    normalizeLocale(getLocales()[0]?.languageTag),
  );
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const [backgroundSyncConflicts, setBackgroundSyncConflicts] = useState<
    readonly SyncConflict[]
  >([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const pathname = usePathname();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";
  const colors = isDark ? darkColors : lightColors;
  const t = createTranslator(locale);

  useEffect(() => {
    const retry = () => {
      void flushPendingDeviceDeregistrations().catch(() => {});
      void flushPendingPushTokenUpdate().catch(() => {});
    };
    retry();
    if (Platform.OS === "web") {
      globalThis.addEventListener("online", retry);
      return () => globalThis.removeEventListener("online", retry);
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") retry();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoadingSession(false);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setOwnerId(data.session?.user.id ?? null);
      setLoadingSession(false);
    });
    return supabase.auth.onAuthStateChange((_event, session) =>
      setOwnerId(session?.user.id ?? null),
    ).data.subscription.unsubscribe;
  }, []);

  useEffect(() => {
    if (!supabase || !ownerId) return;
    void supabase
      .from("profiles")
      .select("locale,theme")
      .eq("id", ownerId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.locale === "en" || data?.locale === "pt-BR")
          setLocale(data.locale);
        if (
          data?.theme === "system" ||
          data?.theme === "light" ||
          data?.theme === "dark"
        )
          setTheme(data.theme);
      });
  }, [ownerId]);

  useEffect(() => {
    if (!ownerId) return;
    let active = true;
    setBackgroundSyncConflicts([]);
    const retry = () => {
      void synchronizeReminders(ownerId)
        .then((conflicts) => {
          if (!active) return;
          setBackgroundSyncConflicts(conflicts);
          setSyncRevision((revision) => revision + 1);
        })
        .catch(() => {});
      void flushNotificationActions(ownerId).catch(() => {});
    };
    retry();
    if (Platform.OS === "web") {
      globalThis.addEventListener("online", retry);
      return () => {
        active = false;
        globalThis.removeEventListener("online", retry);
      };
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") retry();
    });
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      if (state.isConnected) retry();
    });
    return () => {
      active = false;
      subscription.remove();
      unsubscribeNetwork();
    };
  }, [ownerId]);

  useEffect(() => {
    if (!ownerId) return;
    return subscribeToPushTokenChanges((token) => {
      void updateRememberedDeviceToken(ownerId, token).catch(() => {});
    });
  }, [ownerId]);

  useEffect(() => {
    if (!ownerId) return;
    if (Platform.OS === "web") {
      const submitWebAction = async (data: Record<string, unknown>) => {
        if (data.ownerId !== ownerId) return;
        let queued = data.action === "open";
        if (
          data.type === "notification-action" &&
          typeof data.occurrenceId === "string" &&
          (data.action === "dismiss" || data.action === "snooze")
        ) {
          await submitNotificationAction(
            data.occurrenceId,
            data.action,
            ownerId,
          );
          queued = true;
        }
        if (queued && typeof data.cacheKey === "string") {
          const cache = await caches.open("cron-reminder-actions-v1");
          await cache.delete(
            new Request(new URL(data.cacheKey, globalThis.location.origin)),
          );
        }
      };
      const handleMessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "object" || event.data === null) return;
        void submitWebAction(event.data as Record<string, unknown>).catch(
          () => {},
        );
      };
      navigator.serviceWorker.addEventListener("message", handleMessage);
      void caches
        .open("cron-reminder-actions-v1")
        .then(async (cache) => {
          const requests = await cache.keys();
          for (const request of requests) {
            if (
              new URL(request.url).pathname.startsWith(
                "/__cron-reminder-action__/",
              )
            ) {
              const response = await cache.match(request);
              if (!response) continue;
              const data: unknown = await response.json();
              if (typeof data === "object" && data !== null) {
                await submitWebAction(data as Record<string, unknown>);
              }
            }
          }
        })
        .catch(() => {});
      return () =>
        navigator.serviceWorker.removeEventListener("message", handleMessage);
    }
    let remove: (() => void) | undefined;
    let cancelled = false;
    void import("expo-notifications").then((Notifications) => {
      const handleResponse = async (
        response: Awaited<
          ReturnType<typeof Notifications.getLastNotificationResponseAsync>
        >,
      ): Promise<void> => {
        if (cancelled || !response) return;
        const occurrenceId =
          response.notification.request.content.data?.occurrenceId;
        const notificationOwnerId =
          response.notification.request.content.data?.ownerId;
        const action = response.actionIdentifier;
        if (
          notificationOwnerId === ownerId &&
          typeof occurrenceId === "string" &&
          (action === "dismiss" || action === "snooze")
        )
          await submitNotificationAction(occurrenceId, action, ownerId);
      };
      void Notifications.getLastNotificationResponseAsync().then((response) => {
        if (cancelled || !response) return;
        void handleResponse(response)
          .then(() => Notifications.clearLastNotificationResponseAsync())
          .catch(() => {});
      });
      const subscription =
        Notifications.addNotificationResponseReceivedListener((response) => {
          void handleResponse(response)
            .then(() => Notifications.clearLastNotificationResponseAsync())
            .catch(() => {});
        });
      if (cancelled) subscription.remove();
      else remove = () => subscription.remove();
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [ownerId]);

  if (loadingSession) {
    return <CenteredMessage text="Loading…" colors={colors} />;
  }
  if (!ownerId) {
    return (
      <SignIn
        locale={locale}
        colors={colors}
        configured={Boolean(authentication)}
      />
    );
  }

  const appContext: AppContextValue = {
    ownerId,
    syncRevision,
    backgroundSyncConflicts,
    locale,
    setLocale,
    theme,
    setTheme,
    colors,
  };

  return (
    <AppContext.Provider value={appContext}>
      <SafeAreaView
        style={[styles.safe, { backgroundColor: colors.background }]}
      >
        <StatusBar style={isDark ? "light" : "dark"} />
        <View style={[styles.shell, width > 900 && styles.wideShell]}>
          <View style={[styles.navigation, { borderColor: colors.border }]}>
            <Text style={[styles.brand, { color: colors.text }]}>
              ⏱ Cron Reminder
            </Text>
            <View style={styles.navItems}>
              {navigationItems.map((item) => (
                <Button
                  key={item.key}
                  label={t(item.key)}
                  onPress={() => router.navigate(item.path)}
                  active={pathname === item.path}
                  selected={pathname === item.path}
                  colors={colors}
                />
              ))}
            </View>
          </View>
          <View style={styles.content}>
            <Stack screenOptions={{ headerShown: false }} />
          </View>
        </View>
      </SafeAreaView>
    </AppContext.Provider>
  );
}

export function RemindersRoute() {
  const { ownerId, syncRevision, backgroundSyncConflicts, locale, colors } =
    useAppContext();
  return (
    <ReminderList
      ownerId={ownerId}
      syncRevision={syncRevision}
      backgroundSyncConflicts={backgroundSyncConflicts}
      locale={locale}
      colors={colors}
    />
  );
}

export function HistoryRoute() {
  const { ownerId, locale, colors } = useAppContext();
  return <HistoryScreen ownerId={ownerId} locale={locale} colors={colors} />;
}

export function SettingsRoute() {
  const { ownerId, locale, setLocale, theme, setTheme, colors } =
    useAppContext();
  return (
    <Settings
      ownerId={ownerId}
      locale={locale}
      setLocale={setLocale}
      theme={theme}
      setTheme={setTheme}
      colors={colors}
    />
  );
}

interface HistoryRow {
  id: string;
  reminder_id: string;
  event_type: string;
  occurred_at: string;
}

interface HistoryCursor {
  occurredAt: string;
  id: string;
}

function HistoryScreen({
  ownerId,
  locale,
  colors,
}: {
  ownerId: string;
  locale: Locale;
  colors: Colors;
}) {
  const pageSize = 100;
  const t = createTranslator(locale);
  const [events, setEvents] = useState<HistoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<HistoryCursor | null>(null);
  const loadPage = useCallback(
    async (after: HistoryCursor | null, replace = false) => {
      if (!supabase) return;
      setLoading(true);
      try {
        const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        let request = supabase
          .from("history")
          .select("id,reminder_id,event_type,occurred_at")
          .eq("owner_id", ownerId)
          .gte("occurred_at", cutoff)
          .order("occurred_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(pageSize);
        if (after) {
          request = request.or(
            `occurred_at.lt.${after.occurredAt},and(occurred_at.eq.${after.occurredAt},id.lt.${after.id})`,
          );
        }
        const { data, error } = await request;
        if (error) throw error;
        const page = (data ?? []) as HistoryRow[];
        setEvents((current) => (replace ? page : [...current, ...page]));
        setHasMore(page.length === pageSize);
        const last = page[page.length - 1];
        setCursor(last ? { occurredAt: last.occurred_at, id: last.id } : after);
      } finally {
        setLoading(false);
      }
    },
    [ownerId],
  );
  useEffect(() => {
    setEvents([]);
    setHasMore(true);
    setCursor(null);
    void loadPage(null, true);
  }, [loadPage, ownerId]);
  const visible = events.filter((event) =>
    `${event.reminder_id} ${event.event_type}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <FlatList
      data={visible}
      keyExtractor={(event) => event.id}
      contentContainerStyle={styles.page}
      onEndReached={() => {
        if (hasMore && !loading) void loadPage(cursor);
      }}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <>
          <Text
            accessibilityRole="header"
            style={[styles.heading, { color: colors.text }]}
          >
            {t("history")}
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            Triggered, dismissed, postponed, missed, and delivery failures are
            retained for 30 days.
          </Text>
          <Field
            label={t("search")}
            value={query}
            onChangeText={setQuery}
            colors={colors}
          />
        </>
      }
      ListEmptyComponent={
        <EmptyState title={t("history")} message={t("empty")} colors={colors} />
      }
      renderItem={({ item: event }) => (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            {event.event_type}
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            {event.reminder_id}
          </Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            {new Date(event.occurred_at).toLocaleString(locale)}
          </Text>
        </View>
      )}
    />
  );
}

function SignIn({
  locale,
  colors,
  configured,
}: {
  locale: Locale;
  colors: Colors;
  configured: boolean;
}) {
  const t = createTranslator(locale);
  const providers = [
    ["google", "Google"],
    ["apple", "Apple"],
    ["azure", "Microsoft"],
    ["github", "GitHub"],
  ] as const;
  return (
    <SafeAreaView
      style={[
        styles.safe,
        styles.center,
        { backgroundColor: colors.background },
      ]}
    >
      <View
        style={[
          styles.card,
          styles.signInCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: colors.text }]}
        >
          Cron Reminder
        </Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          {t("signIn")}
        </Text>
        {!configured && (
          <Text
            accessibilityRole="alert"
            style={[styles.notice, { color: colors.warning }]}
          >
            Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to
            enable sign-in.
          </Text>
        )}
        {providers.map(([provider, label]) => (
          <Button
            key={provider}
            label={label}
            disabled={!configured}
            onPress={() => void authentication?.signIn(provider)}
            colors={colors}
          />
        ))}
      </View>
    </SafeAreaView>
  );
}

function ReminderList({
  ownerId,
  syncRevision,
  backgroundSyncConflicts,
  locale,
  colors,
}: {
  ownerId: string;
  syncRevision: number;
  backgroundSyncConflicts: readonly SyncConflict[];
  locale: Locale;
  colors: Colors;
}) {
  const t = createTranslator(locale);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Reminder["status"] | "all">("all");
  const [editing, setEditing] = useState<Reminder | "new" | null>(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncConflicts, setSyncConflicts] = useState<readonly SyncConflict[]>(
    [],
  );
  const refresh = useCallback(
    () => void localRepository.list(ownerId).then(setReminders),
    [ownerId],
  );
  useEffect(() => {
    setSyncConflicts(backgroundSyncConflicts);
    setSyncMessage(
      backgroundSyncConflicts.length
        ? `${backgroundSyncConflicts.length} concurrent edit(s) need manual resolution. Local versions are preserved.`
        : "",
    );
    refresh();
  }, [backgroundSyncConflicts, refresh, syncRevision]);
  useEffect(() => {
    setSyncConflicts([]);
    setSyncMessage("");
  }, [ownerId]);
  useEffect(() => {
    let active = true;
    void synchronizeReminders(ownerId)
      .then((conflicts) => {
        if (!active) return;
        setSyncConflicts(conflicts);
        setSyncMessage(
          conflicts.length
            ? `${conflicts.length} concurrent edit(s) need manual resolution. Local versions are preserved.`
            : "",
        );
        refresh();
      })
      .catch(() =>
        active
          ? setSyncMessage(
              "Offline changes will synchronize when connectivity returns.",
            )
          : undefined,
      );
    return () => {
      active = false;
    };
  }, [ownerId, refresh]);
  const visible = useMemo(
    () => filterReminders(reminders, { query, status, sort: "updated" }),
    [query, reminders, status],
  );

  if (editing) {
    return (
      <ReminderEditor
        ownerId={ownerId}
        reminder={editing === "new" ? undefined : editing}
        locale={locale}
        colors={colors}
        onCancel={() => setEditing(null)}
        onSaved={(conflicts) => {
          setSyncConflicts(conflicts);
          setSyncMessage(
            conflicts.length
              ? `${conflicts.length} concurrent edit(s) need manual resolution. Local versions are preserved.`
              : "",
          );
          setEditing(null);
          refresh();
        }}
      />
    );
  }

  async function mutate(
    action: () => Promise<unknown>,
    alreadySerialized = false,
  ) {
    if (alreadySerialized) await action();
    else await runReminderMutation(action);
    try {
      setSyncConflicts(await synchronizeReminders(ownerId));
    } catch {
      setSyncMessage(
        "Offline changes will synchronize when connectivity returns.",
      );
    }
    refresh();
  }

  function remove(reminder: Reminder) {
    confirmDestructiveAction(
      t("delete"),
      t("confirmDelete"),
      t("cancel"),
      t("delete"),
      () => void mutate(() => deleteReminder(reminder.id, ownerId), true),
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.titleRow}>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: colors.text }]}
        >
          {t("reminders")}
        </Text>
        <Button
          label={`＋ ${t("addReminder")}`}
          onPress={() => setEditing("new")}
          colors={colors}
        />
      </View>
      {syncMessage && (
        <Text
          accessibilityRole="alert"
          style={[styles.notice, { color: colors.warning }]}
        >
          {syncMessage}
        </Text>
      )}
      {syncConflicts.map((conflict) => (
        <View
          key={conflict.id}
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.warning },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Resolve concurrent edit: {conflict.local.title}
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            Local: {conflict.local.title} · Remote: {conflict.remote.title}
          </Text>
          <View style={styles.actions}>
            {(["local", "remote"] as const).map((choice) => (
              <Button
                key={choice}
                label={`Keep ${choice}`}
                colors={colors}
                onPress={() =>
                  void resolveSynchronizationConflict(
                    conflict,
                    conflict[choice],
                  ).then(() => {
                    setSyncConflicts((items) =>
                      items.filter(({ id }) => id !== conflict.id),
                    );
                    refresh();
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}
      <TextInput
        accessibilityLabel={t("search")}
        placeholder={t("search")}
        placeholderTextColor={colors.muted}
        value={query}
        onChangeText={setQuery}
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          },
        ]}
      />
      <View style={styles.chips}>
        {(["all", "active", "disabled", "archived"] as const).map((item) => (
          <Button
            key={item}
            label={item === "all" ? "All" : t(item)}
            onPress={() => setStatus(item)}
            active={status === item}
            selected={status === item}
            colors={colors}
            compact
          />
        ))}
      </View>
      {visible.length === 0 && (
        <EmptyState
          title={t("empty")}
          message={t("addReminder")}
          colors={colors}
        />
      )}
      {visible.map((reminder) => (
        <View
          key={reminder.id}
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View style={styles.titleRow}>
            <View style={styles.flex}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>
                {reminder.title}
              </Text>
              <Text style={[styles.body, { color: colors.muted }]}>
                {describeSchedule(reminder.schedule, locale)}
              </Text>
              {reminder.tags.length > 0 && (
                <Text style={[styles.caption, { color: colors.accent }]}>
                  #{reminder.tags.join(" #")}
                </Text>
              )}
            </View>
            {reminder.status !== "archived" && (
              <Switch
                accessibilityLabel={`${reminder.title}: ${t("enabled")}`}
                value={reminder.status === "active"}
                onValueChange={(value) =>
                  void mutate(() =>
                    service.setEnabled(ownerId, reminder.id, value),
                  )
                }
              />
            )}
          </View>
          <View style={styles.actions}>
            <Button
              label={t("edit")}
              onPress={() => setEditing(reminder)}
              colors={colors}
              compact
            />
            <Button
              label={t("duplicate")}
              onPress={() =>
                void mutate(() => service.duplicate(ownerId, reminder.id))
              }
              colors={colors}
              compact
            />
            <Button
              label={
                reminder.status === "archived" ? t("restore") : t("archive")
              }
              onPress={() =>
                void mutate(() =>
                  reminder.status === "archived"
                    ? service.restore(ownerId, reminder.id)
                    : service.archive(ownerId, reminder.id),
                )
              }
              colors={colors}
              compact
            />
            <Button
              label={t("delete")}
              onPress={() => remove(reminder)}
              colors={colors}
              danger
              compact
            />
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function ReminderEditor({
  ownerId,
  reminder,
  locale,
  colors,
  onCancel,
  onSaved,
}: {
  ownerId: string;
  reminder?: Reminder;
  locale: Locale;
  colors: Colors;
  onCancel: () => void;
  onSaved: (conflicts: readonly SyncConflict[]) => void;
}) {
  const t = createTranslator(locale);
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [notes, setNotes] = useState(reminder?.notes ?? "");
  const [tags, setTags] = useState(reminder?.tags.join(", ") ?? "");
  const [kind, setKind] = useState<EditorKind>(
    inferEditorKind(reminder?.schedule),
  );
  const [cron, setCron] = useState(
    reminder?.schedule.kind === "cron"
      ? reminder.schedule.expression
      : "0 9 * * *",
  );
  const [onceAt, setOnceAt] = useState(
    reminder?.schedule.kind === "once"
      ? reminder.schedule.at
      : new Date(Date.now() + 3_600_000).toISOString(),
  );
  const [sound, setSound] = useState<ReminderSound>(
    reminder?.sound ?? { mode: "default" },
  );
  const [error, setError] = useState("");
  const deviceTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timezone = reminder?.timezone ?? deviceTimezone;

  function chooseKind(next: EditorKind) {
    setKind(next);
    const expressions: Partial<Record<EditorKind, string>> = {
      interval: "*/5 * * * *",
      daily: "0 9 * * *",
      weekdays: "0 9 * * 1-5",
      monthly: "0 9 1 * *",
      yearly: "0 9 1 1 *",
    };
    if (expressions[next]) setCron(expressions[next] ?? cron);
  }

  const existingCronSchedule =
    reminder?.schedule.kind === "cron" ? reminder.schedule : undefined;
  const schedule: Schedule =
    kind === "once"
      ? { kind: "once", at: onceAt }
      : kind === "advanced"
        ? { ...existingCronSchedule, kind: "cron", expression: cron }
        : { kind: "cron", expression: cron };
  const validation =
    schedule.kind === "cron"
      ? validateCronExpression(schedule.expression)
      : (() => {
          try {
            validateSchedule(schedule);
            return { valid: true };
          } catch {
            return { valid: false };
          }
        })();
  let preview: Date[] = [];
  if (validation.valid) {
    try {
      preview = nextOccurrences(schedule, timezone, new Date(), 5);
    } catch {
      preview = [];
    }
  }

  async function save() {
    setError("");
    try {
      const changes = {
        title,
        notes,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        schedule,
        timezone,
        sound,
      };
      await runReminderMutation(() =>
        reminder
          ? service.update(ownerId, reminder.id, changes)
          : service.create({ ...changes, ownerId }),
      );
      const conflicts = await synchronizeReminders(ownerId).catch(() => []);
      onSaved(conflicts);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to save reminder.",
      );
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Text
        accessibilityRole="header"
        style={[styles.heading, { color: colors.text }]}
      >
        {reminder ? t("edit") : t("addReminder")}
      </Text>
      <Field
        label={t("title")}
        value={title}
        onChangeText={setTitle}
        colors={colors}
      />
      <Field
        label={t("notes")}
        value={notes}
        onChangeText={setNotes}
        colors={colors}
        multiline
      />
      <Field
        label={`${t("tags")} (comma separated)`}
        value={tags}
        onChangeText={setTags}
        colors={colors}
      />
      <Text style={[styles.label, { color: colors.text }]}>
        {t("schedule")}
      </Text>
      <View style={styles.chips}>
        {(
          [
            "once",
            "interval",
            "daily",
            "weekdays",
            "monthly",
            "yearly",
            "advanced",
          ] as const
        ).map((value) => (
          <Button
            key={value}
            label={t(value)}
            onPress={() => chooseKind(value)}
            active={kind === value}
            selected={kind === value}
            colors={colors}
            compact
          />
        ))}
      </View>
      {kind === "once" ? (
        <Field
          label="ISO date and time"
          value={onceAt}
          onChangeText={setOnceAt}
          colors={colors}
        />
      ) : (
        <Field
          label={kind === "advanced" ? t("advanced") : "Cron"}
          value={cron}
          onChangeText={setCron}
          colors={colors}
        />
      )}
      {!validation.valid && (
        <Text
          accessibilityRole="alert"
          style={[styles.notice, { color: colors.danger }]}
        >
          Enter a valid five-field schedule.
        </Text>
      )}
      {validation.valid && (
        <View style={[styles.preview, { borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            {describeSchedule(schedule, locale)}
          </Text>
          <Text style={[styles.label, { color: colors.text }]}>
            {t("upcoming")}
          </Text>
          {preview.map((date) => (
            <Text
              key={date.toISOString()}
              style={[styles.caption, { color: colors.muted }]}
            >
              {date.toLocaleString(locale, { timeZone: timezone })}
            </Text>
          ))}
        </View>
      )}
      <Text style={[styles.label, { color: colors.text }]}>{t("sound")}</Text>
      <View style={styles.chips}>
        {(["default", "silent", "vibrate"] as const).map((mode) => (
          <Button
            key={mode}
            label={mode}
            onPress={() => setSound({ mode })}
            active={sound.mode === mode}
            selected={sound.mode === mode}
            colors={colors}
            compact
          />
        ))}
        <Button
          label="▶ Preview"
          onPress={() => void previewSound(sound)}
          colors={colors}
          compact
        />
      </View>
      {error && (
        <Text
          accessibilityRole="alert"
          style={[styles.notice, { color: colors.danger }]}
        >
          {error}
        </Text>
      )}
      <View style={styles.actions}>
        <Button label={t("cancel")} onPress={onCancel} colors={colors} />
        <Button
          label={t("save")}
          onPress={() => void save()}
          colors={colors}
          active
          disabled={!validation.valid || !title.trim()}
        />
      </View>
    </ScrollView>
  );
}

async function previewSound(sound: ReminderSound) {
  if (sound.mode === "silent") {
    Alert.alert("Sound", "This reminder will be silent.");
    return;
  }
  if (sound.mode === "vibrate") {
    Vibration.vibrate(300);
    return;
  }
  if (Platform.OS === "web") {
    const AudioContextType = globalThis.AudioContext;
    const context = new AudioContextType();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 660;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    return;
  }
  const Notifications = await import("expo-notifications");
  await Notifications.scheduleNotificationAsync({
    content: { title: "Sound preview", sound: "default" },
    trigger: null,
  });
}

function Settings({
  ownerId,
  locale,
  setLocale,
  theme,
  setTheme,
  colors,
}: {
  ownerId: string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  colors: Colors;
}) {
  const t = createTranslator(locale);
  const [backupText, setBackupText] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [importConflicts, setImportConflicts] = useState<
    readonly SyncConflict[]
  >([]);

  async function exportJson() {
    const json = exportBackup(await localRepository.list(ownerId), new Date());
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "cron-reminder-backup.json";
      link.click();
      URL.revokeObjectURL(url);
    } else {
      await Share.share({ message: json, title: "Cron Reminder backup" });
    }
  }

  async function importJson() {
    try {
      const result = await runReminderMutation(async () => {
        const current = await localRepository.list(ownerId);
        const imported = importBackup(backupText, current, ownerId);
        await Promise.all(
          imported.merged.map((item) => localRepository.save(item)),
        );
        return imported;
      });
      await synchronizeReminders(ownerId).catch(() => []);
      setImportConflicts(result.conflicts);
      setBackupMessage(
        `${result.imported} imported, ${result.skipped} skipped, ${result.invalid} invalid, ${result.conflicts.length} conflict(s) require manual resolution.`,
      );
    } catch {
      setBackupMessage("The backup is invalid or unsupported.");
    }
  }

  function updateLocale(value: Locale) {
    setLocale(value);
    void supabase
      ?.from("profiles")
      .update({ locale: value, updated_at: new Date().toISOString() })
      .eq("id", ownerId);
  }

  function updateTheme(value: ThemePreference) {
    setTheme(value);
    if (Platform.OS !== "web") {
      (
        Appearance as typeof Appearance & {
          setColorScheme: (scheme: "light" | "dark" | null) => void;
        }
      ).setColorScheme(value === "system" ? null : value);
    }
    void supabase
      ?.from("profiles")
      .update({ theme: value, updated_at: new Date().toISOString() })
      .eq("id", ownerId);
  }

  async function enableNotifications() {
    const registration = await new DeviceNotificationAdapter().register(
      ownerId,
    );
    if (!registration) {
      Alert.alert(
        "Notifications",
        "Permission was denied or Web Push is unavailable.",
      );
      return;
    }

    if (supabase) {
      const deregistrationToken = Crypto.randomUUID();
      const rememberedDevice = await getRememberedDeviceRegistration();
      const deviceId = rememberedDevice?.id ?? Crypto.randomUUID();
      const { data, error } = await supabase.rpc("claim_device_token", {
        p_device_id: deviceId,
        p_platform: registration.platform,
        p_token: registration.token,
        p_deregistration_token: deregistrationToken,
        p_existing_deregistration_token: rememberedDevice?.token ?? null,
      });
      if (error) throw error;
      if (!data) throw new Error("Unable to claim push token.");
      await rememberDevice(deviceId, deregistrationToken);
    } else {
      return;
    }
    Alert.alert("Notifications", "This device is registered.");
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text
        accessibilityRole="header"
        style={[styles.heading, { color: colors.text }]}
      >
        {t("settings")}
      </Text>
      <Text style={[styles.label, { color: colors.text }]}>
        {t("language")}
      </Text>
      <View style={styles.chips}>
        <Button
          label="English"
          onPress={() => updateLocale("en")}
          active={locale === "en"}
          selected={locale === "en"}
          colors={colors}
        />
        <Button
          label="Português (Brasil)"
          onPress={() => updateLocale("pt-BR")}
          active={locale === "pt-BR"}
          selected={locale === "pt-BR"}
          colors={colors}
        />
      </View>
      <Text style={[styles.label, { color: colors.text }]}>{t("theme")}</Text>
      <View style={styles.chips}>
        {(["system", "light", "dark"] as const).map((value) => (
          <Button
            key={value}
            label={value}
            onPress={() => updateTheme(value)}
            active={theme === value}
            selected={theme === value}
            colors={colors}
          />
        ))}
      </View>
      <Button
        label="Export JSON"
        onPress={() => void exportJson()}
        colors={colors}
      />
      <Field
        label={t("importBackupPrompt")}
        value={backupText}
        onChangeText={setBackupText}
        colors={colors}
        multiline
      />
      <Button
        label={t("importBackup")}
        onPress={() => void importJson()}
        colors={colors}
        disabled={!backupText.trim()}
      />
      {backupMessage && (
        <Text accessibilityRole="alert" style={{ color: colors.muted }}>
          {backupMessage}
        </Text>
      )}
      {importConflicts.map((conflict) => (
        <View
          key={conflict.id}
          style={[styles.card, { borderColor: colors.warning }]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            {conflict.local.title}
          </Text>
          <View style={styles.actions}>
            {(["local", "remote"] as const).map((choice) => (
              <Button
                key={choice}
                label={`Keep ${choice === "local" ? "existing" : "imported"}`}
                colors={colors}
                onPress={() =>
                  void runReminderMutation(() =>
                    localRepository.save({
                      ...conflict[choice],
                      revision:
                        Math.max(
                          conflict.local.revision,
                          conflict.remote.revision,
                        ) + 1,
                      updatedAt: new Date().toISOString(),
                    }),
                  )
                    .then(() => synchronizeReminders(ownerId).catch(() => []))
                    .then(() =>
                      setImportConflicts((items) =>
                        items.filter(({ id }) => id !== conflict.id),
                      ),
                    )
                }
              />
            ))}
          </View>
        </View>
      ))}
      <Button
        label={t("enableNotifications")}
        onPress={() =>
          void enableNotifications().catch(() =>
            Alert.alert("Notifications", "Device registration failed."),
          )
        }
        colors={colors}
      />
      <Button
        label={t("signOut")}
        onPress={() => void authentication?.signOut()}
        colors={colors}
      />
      <Button
        label={t("deleteAccount")}
        onPress={() =>
          confirmDestructiveAction(
            t("deleteAccountTitle"),
            t("deleteAccountMessage"),
            t("cancel"),
            t("delete"),
            () => void authentication?.deleteAccount(),
          )
        }
        colors={colors}
        danger
      />
    </ScrollView>
  );
}

function inferEditorKind(schedule: Schedule | undefined): EditorKind {
  if (!schedule) return "daily";
  if (schedule.kind === "once") return "once";
  if (
    schedule.startAt !== undefined ||
    schedule.endAt !== undefined ||
    schedule.occurrenceLimit !== undefined
  ) {
    return "advanced";
  }
  const presets: Record<string, EditorKind> = {
    "*/5 * * * *": "interval",
    "0 9 * * *": "daily",
    "0 9 * * 1-5": "weekdays",
    "0 9 1 * *": "monthly",
    "0 9 1 1 *": "yearly",
  };
  return presets[schedule.expression.trim()] ?? "advanced";
}

function confirmDestructiveAction(
  title: string,
  message: string,
  cancelLabel: string,
  confirmLabel: string,
  onConfirm: () => void,
) {
  if (Platform.OS === "web") {
    if (globalThis.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: "cancel" },
    { text: confirmLabel, style: "destructive", onPress: onConfirm },
  ]);
}

function Field({
  label,
  colors,
  ...props
}: {
  label: string;
  colors: Colors;
  value: string;
  onChangeText: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <View>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          props.multiline && styles.multiline,
          {
            color: colors.text,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          },
        ]}
        {...props}
      />
    </View>
  );
}

function Button({
  label,
  onPress,
  colors,
  active,
  selected = false,
  danger,
  compact,
  disabled,
}: {
  label: string;
  onPress: () => void;
  colors: Colors;
  active?: boolean;
  selected?: boolean;
  danger?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        {
          backgroundColor: active ? colors.accent : colors.surface,
          borderColor: colors.border,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          {
            color: danger
              ? colors.danger
              : active
                ? colors.background
                : colors.text,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function EmptyState({
  title,
  message,
  colors,
}: {
  title: string;
  message: string;
  colors: Colors;
}) {
  return (
    <View style={[styles.empty, { borderColor: colors.border }]}>
      <Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.body, { color: colors.muted }]}>{message}</Text>
    </View>
  );
}

function CenteredMessage({ text, colors }: { text: string; colors: Colors }) {
  return (
    <SafeAreaView
      style={[
        styles.safe,
        styles.center,
        { backgroundColor: colors.background },
      ]}
    >
      <Text style={{ color: colors.text }}>{text}</Text>
    </SafeAreaView>
  );
}

interface Colors {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  danger: string;
  warning: string;
}
const lightColors: Colors = {
  background: "#f7f7fb",
  surface: "#ffffff",
  text: "#161622",
  muted: "#616173",
  border: "#d9d9e3",
  accent: "#5b47d6",
  danger: "#b42318",
  warning: "#9a6700",
};
const darkColors: Colors = {
  background: "#111118",
  surface: "#1c1c26",
  text: "#f6f6fa",
  muted: "#a5a5b5",
  border: "#393947",
  accent: "#8878f2",
  danger: "#ff8a80",
  warning: "#f2cc60",
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  shell: { flex: 1 },
  wideShell: { flexDirection: "row" },
  navigation: { padding: 16, borderBottomWidth: 1, gap: 14 },
  brand: { fontSize: 20, fontWeight: "800" },
  navItems: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  content: { flex: 1 },
  page: {
    width: "100%",
    maxWidth: 850,
    alignSelf: "center",
    padding: 20,
    gap: 16,
  },
  center: { alignItems: "center", justifyContent: "center", padding: 20 },
  signInCard: { width: "100%", maxWidth: 420 },
  heading: { fontSize: 30, fontWeight: "800" },
  cardTitle: { fontSize: 18, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 20 },
  label: { fontSize: 14, fontWeight: "700", marginBottom: 6 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  flex: { flex: 1 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  multiline: { minHeight: 90, paddingTop: 12, textAlignVertical: "top" },
  button: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  compactButton: { minHeight: 36, paddingHorizontal: 11 },
  buttonText: { fontWeight: "700" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  empty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 16,
    padding: 30,
    alignItems: "center",
    gap: 8,
  },
  preview: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 5 },
  notice: { fontWeight: "600", lineHeight: 20 },
});
