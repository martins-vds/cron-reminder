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
  type ReactNode,
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
  ActivityIndicator,
} from "react-native";
import {
  ReminderService,
  filterReminders,
  sameReminder,
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
  type MessageKey,
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
import { NotificationRegistrationError } from "./src/notificationErrors";
import {
  darkColors,
  lightColors,
  radius,
  size,
  space,
  type,
  type AppColors as Colors,
} from "./src/theme";

type ThemePreference = "system" | "light" | "dark";
type NotificationRegistrationStatus =
  "idle" | "registering" | "registered" | "error";
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
  const isWide = width >= 880;
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
    return <CenteredMessage text="Loading..." colors={colors} />;
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
        <View style={[styles.shell, isWide && styles.wideShell]}>
          <View
            style={[
              styles.navigation,
              isWide ? styles.sideNavigation : styles.topNavigation,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.brandLockup}>
              <BrandMark colors={colors} />
              <View style={styles.brandCopy}>
                <Text style={[styles.brand, { color: colors.text }]}>
                  Cron Reminder
                </Text>
                {isWide && (
                  <Text style={[styles.brandMeta, { color: colors.subtle }]}>
                    Scheduled, simply.
                  </Text>
                )}
              </View>
            </View>
            <View style={[styles.navItems, isWide && styles.navItemsWide]}>
              {navigationItems.map((item) => (
                <Button
                  key={item.key}
                  label={t(item.key)}
                  onPress={() => router.navigate(item.path)}
                  active={pathname === item.path}
                  selected={pathname === item.path}
                  colors={colors}
                  variant="nav"
                  compact
                  block={isWide}
                  grow={!isWide}
                />
              ))}
            </View>
          </View>
          <View
            style={[styles.content, { backgroundColor: colors.background }]}
          >
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            />
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
        <View style={styles.listHeader}>
          <PageHeader
            eyebrow={copy(locale, "Activity", "Atividade")}
            title={t("history")}
            description={copy(
              locale,
              "A 30-day record of triggers, snoozes, dismissals, and delivery issues.",
              "Um registro de 30 dias de disparos, adiamentos, dispensas e problemas de entrega.",
            )}
            colors={colors}
          />
          <View
            style={[
              styles.controlPanel,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          >
            <Field
              label={t("search")}
              value={query}
              onChangeText={setQuery}
              colors={colors}
              placeholder={copy(
                locale,
                "Search by reminder or event",
                "Busque por lembrete ou evento",
              )}
            />
          </View>
          {visible.length > 0 && (
            <Text style={[styles.sectionLabel, { color: colors.subtle }]}>
              {copy(locale, "Recent activity", "Atividade recente")}
            </Text>
          )}
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          title={copy(locale, "No activity yet", "Nenhuma atividade ainda")}
          message={copy(
            locale,
            "Events appear here after a reminder runs or you take an action.",
            "Os eventos aparecem aqui depois que um lembrete é executado ou você realiza uma ação.",
          )}
          colors={colors}
        />
      }
      renderItem={({ item: event }) => (
        <View
          style={[
            styles.historyRow,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <View
            style={[
              styles.timelineMarker,
              { backgroundColor: colors.accentSoft },
            ]}
          />
          <View style={styles.flex}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              {event.event_type.replace(/_/g, " ")}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.body, { color: colors.muted }]}
            >
              {event.reminder_id}
            </Text>
          </View>
          <Text style={[styles.caption, { color: colors.subtle }]}>
            {new Date(event.occurred_at).toLocaleString(locale)}
          </Text>
        </View>
      )}
      ListFooterComponent={
        loading ? (
          <ActivityIndicator
            color={colors.accent}
            accessibilityLabel={copy(
              locale,
              "Loading activity",
              "Carregando atividade",
            )}
          />
        ) : null
      }
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
  const { width } = useWindowDimensions();
  const isWide = width >= 760;
  const enabledProviders = new Set(
    (process.env.EXPO_PUBLIC_AUTH_PROVIDERS ?? "google,apple,azure,github")
      .split(",")
      .map((provider: string) => provider.trim()),
  );
  const providers = (
    [
      ["google", "Google"],
      ["apple", "Apple"],
      ["azure", "Microsoft"],
      ["github", "GitHub"],
    ] as const
  ).filter(([provider]) => enabledProviders.has(provider));
  return (
    <SafeAreaView
      style={[
        styles.safe,
        styles.authShell,
        isWide && styles.authShellWide,
        { backgroundColor: colors.background },
      ]}
    >
      <View style={[styles.authLayout, isWide && styles.authLayoutWide]}>
        <View style={[styles.authIntro, isWide && styles.authIntroWide]}>
          <View style={styles.brandLockup}>
            <BrandMark colors={colors} />
            <Text style={[styles.brand, { color: colors.text }]}>
              Cron Reminder
            </Text>
          </View>
          <Text
            accessibilityRole="header"
            style={[
              styles.authHeading,
              isWide && styles.authHeadingWide,
              { color: colors.text },
            ]}
          >
            {copy(
              locale,
              "Make time-sensitive work hard to miss.",
              "Torne tarefas com prazo difíceis de esquecer.",
            )}
          </Text>
          <Text style={[styles.authBody, { color: colors.muted }]}>
            {copy(
              locale,
              "Create precise recurring reminders, keep them synced, and review what happened from any device.",
              "Crie lembretes recorrentes precisos, mantenha tudo sincronizado e consulte o histórico em qualquer dispositivo.",
            )}
          </Text>
          <View style={styles.authFeatureList}>
            {[
              copy(locale, "Flexible schedules", "Agendas flexíveis"),
              copy(locale, "Reliable notifications", "Notificações confiáveis"),
              copy(
                locale,
                "Private synchronized history",
                "Histórico privado e sincronizado",
              ),
            ].map((feature) => (
              <View key={feature} style={styles.authFeature}>
                <View
                  style={[
                    styles.featureMark,
                    { backgroundColor: colors.accent },
                  ]}
                />
                <Text style={[styles.body, { color: colors.text }]}>
                  {feature}
                </Text>
              </View>
            ))}
          </View>
        </View>
        <View
          style={[
            styles.authCard,
            {
              backgroundColor: colors.surfaceElevated,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.authCardTitle, { color: colors.text }]}>
            {t("signIn")}
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            {copy(
              locale,
              "Choose a provider to access your reminders.",
              "Escolha um provedor para acessar seus lembretes.",
            )}
          </Text>
          {!configured && (
            <Notice
              tone="warning"
              colors={colors}
              text={copy(
                locale,
                "Authentication is not configured for this deployment.",
                "A autenticação não está configurada para esta implantação.",
              )}
            >
              <Text style={[styles.caption, { color: colors.warning }]}>
                Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.
              </Text>
            </Notice>
          )}
          <View style={styles.authActions}>
            {providers.map(([provider, label]) => (
              <Button
                key={provider}
                label={copy(
                  locale,
                  `Continue with ${label}`,
                  `Continuar com ${label}`,
                )}
                disabled={!configured}
                onPress={() => void authentication?.signIn(provider)}
                colors={colors}
                variant={
                  provider === providers[0]?.[0] ? "primary" : "secondary"
                }
              />
            ))}
          </View>
          <Text style={[styles.caption, { color: colors.subtle }]}>
            {copy(
              locale,
              "Your provider verifies your identity. Cron Reminder never receives your password.",
              "Seu provedor verifica sua identidade. O Cron Reminder nunca recebe sua senha.",
            )}
          </Text>
        </View>
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
    setSyncMessage("");
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
        setSyncMessage("");
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
  const activeSyncConflicts = useMemo(
    () =>
      syncConflicts.filter((conflict) => {
        const current = reminders.find(({ id }) => id === conflict.id);
        return current !== undefined && sameReminder(current, conflict.local);
      }),
    [reminders, syncConflicts],
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
          setSyncMessage("");
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
      setSyncMessage("");
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
      <PageHeader
        eyebrow={copy(locale, "Workspace", "Área de trabalho")}
        title={t("reminders")}
        description={copy(
          locale,
          "Create precise schedules and keep every important follow-up visible.",
          "Crie agendas precisas e mantenha cada acompanhamento importante visível.",
        )}
        colors={colors}
        action={
          <Button
            label={t("addReminder")}
            onPress={() => setEditing("new")}
            colors={colors}
            variant="primary"
          />
        }
      />
      {syncMessage && (
        <Notice tone="warning" colors={colors} text={syncMessage} />
      )}
      {activeSyncConflicts.length > 0 && (
        <Notice
          tone="warning"
          colors={colors}
          text={`${activeSyncConflicts.length} concurrent edit(s) need manual resolution. Local versions are preserved.`}
        />
      )}
      {activeSyncConflicts.map((conflict) => (
        <View
          key={conflict.id}
          style={[
            styles.conflictCard,
            {
              backgroundColor: colors.warningSoft,
              borderColor: colors.warning,
            },
          ]}
        >
          <View style={styles.flex}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Resolve concurrent edit
            </Text>
            <Text style={[styles.body, { color: colors.muted }]}>
              Local: {conflict.local.title}. Remote: {conflict.remote.title}.
            </Text>
          </View>
          <View style={styles.actions}>
            {(["local", "remote"] as const).map((choice) => (
              <Button
                key={choice}
                label={`Keep ${choice}`}
                colors={colors}
                variant="secondary"
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
      <View
        style={[
          styles.controlPanel,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
      >
        <Field
          label={t("search")}
          placeholder={copy(
            locale,
            "Search by title, schedule, or tag",
            "Busque por título, agenda ou etiqueta",
          )}
          value={query}
          onChangeText={setQuery}
          colors={colors}
        />
        <View style={styles.filterGroup}>
          <Text style={[styles.sectionLabel, { color: colors.subtle }]}>
            {copy(locale, "Show", "Mostrar")}
          </Text>
          <View style={styles.chips}>
            {(["all", "active", "disabled", "archived"] as const).map(
              (item) => (
                <Button
                  key={item}
                  label={
                    item === "all" ? copy(locale, "All", "Todos") : t(item)
                  }
                  onPress={() => setStatus(item)}
                  active={status === item}
                  selected={status === item}
                  colors={colors}
                  variant="chip"
                  compact
                />
              ),
            )}
          </View>
        </View>
      </View>
      {visible.length === 0 && (
        <EmptyState
          title={
            reminders.length === 0
              ? t("empty")
              : copy(
                  locale,
                  "No matching reminders",
                  "Nenhum lembrete encontrado",
                )
          }
          message={
            reminders.length === 0
              ? copy(
                  locale,
                  "Start with the next thing you cannot afford to miss.",
                  "Comece pela próxima coisa que você não pode esquecer.",
                )
              : copy(
                  locale,
                  "Try a different search or status filter.",
                  "Tente outra busca ou filtro de status.",
                )
          }
          colors={colors}
          action={
            reminders.length === 0 ? (
              <Button
                label={t("addReminder")}
                onPress={() => setEditing("new")}
                colors={colors}
                variant="primary"
              />
            ) : undefined
          }
        />
      )}
      {visible.length > 0 && (
        <View style={styles.sectionHeadingRow}>
          <Text style={[styles.sectionLabel, { color: colors.subtle }]}>
            {copy(locale, "Your schedules", "Suas agendas")}
          </Text>
          <Text style={[styles.caption, { color: colors.subtle }]}>
            {visible.length} {copy(locale, "shown", "exibidos")}
          </Text>
        </View>
      )}
      {visible.map((reminder) => (
        <View
          key={reminder.id}
          style={[
            styles.reminderCard,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={styles.titleRow}>
            <View style={styles.flex}>
              <View style={styles.reminderTitleRow}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>
                  {reminder.title}
                </Text>
                <StatusBadge
                  label={t(reminder.status)}
                  tone={
                    reminder.status === "active"
                      ? "success"
                      : reminder.status === "archived"
                        ? "neutral"
                        : "warning"
                  }
                  colors={colors}
                />
              </View>
              <Text style={[styles.body, { color: colors.muted }]}>
                {describeSchedule(reminder.schedule, locale)}
              </Text>
              {reminder.tags.length > 0 && (
                <View style={styles.tagRow}>
                  {reminder.tags.map((tag) => (
                    <Text
                      key={tag}
                      style={[
                        styles.tag,
                        {
                          color: colors.accent,
                          backgroundColor: colors.accentSoft,
                        },
                      ]}
                    >
                      {tag}
                    </Text>
                  ))}
                </View>
              )}
            </View>
            {reminder.status !== "archived" && (
              <Switch
                accessibilityLabel={`${reminder.title}: ${t("enabled")}`}
                value={reminder.status === "active"}
                trackColor={{
                  false: colors.surfaceMuted,
                  true: colors.accentSoft,
                }}
                thumbColor={
                  reminder.status === "active"
                    ? colors.accent
                    : colors.borderStrong
                }
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
              variant="secondary"
              compact
            />
            <Button
              label={t("duplicate")}
              onPress={() =>
                void mutate(() => service.duplicate(ownerId, reminder.id))
              }
              colors={colors}
              variant="ghost"
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
              variant="ghost"
              compact
            />
            <Button
              label={t("delete")}
              onPress={() => remove(reminder)}
              colors={colors}
              danger
              variant="danger"
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
  const { width } = useWindowDimensions();
  const isWide = width >= 1120;
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
      <PageHeader
        eyebrow={copy(locale, "Reminder setup", "Configuração do lembrete")}
        title={reminder ? t("edit") : t("addReminder")}
        description={copy(
          locale,
          "Define what should happen and when. You can refine the schedule before saving.",
          "Defina o que deve acontecer e quando. Você pode ajustar a agenda antes de salvar.",
        )}
        colors={colors}
      />
      <View style={[styles.screenGrid, isWide && styles.screenGridWide]}>
        <View
          style={[styles.screenColumn, isWide && styles.editorDetailsColumn]}
        >
          <SectionCard
            title={copy(locale, "Details", "Detalhes")}
            description={copy(
              locale,
              "Give this reminder a clear name and optional context.",
              "Dê um nome claro e um contexto opcional a este lembrete.",
            )}
            colors={colors}
          >
            <View style={styles.formStack}>
              <Field
                label={t("title")}
                value={title}
                onChangeText={setTitle}
                colors={colors}
                placeholder={copy(
                  locale,
                  "For example, submit weekly report",
                  "Por exemplo, enviar relatório semanal",
                )}
              />
              <Field
                label={t("notes")}
                value={notes}
                onChangeText={setNotes}
                colors={colors}
                multiline
                placeholder={copy(
                  locale,
                  "Add useful context or a checklist",
                  "Adicione um contexto útil ou uma lista",
                )}
              />
              <Field
                label={`${t("tags")} (${copy(locale, "comma separated", "separadas por vírgula")})`}
                value={tags}
                onChangeText={setTags}
                colors={colors}
                placeholder={copy(
                  locale,
                  "work, finance",
                  "trabalho, finanças",
                )}
              />
            </View>
          </SectionCard>
        </View>
        <View
          style={[styles.screenColumn, isWide && styles.editorScheduleColumn]}
        >
          <SectionCard
            title={t("schedule")}
            description={copy(
              locale,
              "Choose a common rhythm or enter an advanced cron expression.",
              "Escolha um ritmo comum ou insira uma expressão cron avançada.",
            )}
            colors={colors}
          >
            <View style={styles.formStack}>
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
                    variant="chip"
                    compact
                  />
                ))}
              </View>
              {kind === "once" ? (
                <Field
                  label={copy(locale, "ISO date and time", "Data e hora ISO")}
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
                <Notice
                  tone="danger"
                  colors={colors}
                  text={copy(
                    locale,
                    "Enter a valid five-field schedule.",
                    "Insira uma agenda válida de cinco campos.",
                  )}
                />
              )}
              {validation.valid && (
                <View
                  style={[
                    styles.preview,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.surfaceMuted,
                    },
                  ]}
                >
                  <Text style={[styles.cardTitle, { color: colors.text }]}>
                    {describeSchedule(schedule, locale)}
                  </Text>
                  <Text style={[styles.sectionLabel, { color: colors.subtle }]}>
                    {t("upcoming")}
                  </Text>
                  <View style={styles.previewList}>
                    {preview.map((date, index) => (
                      <View key={date.toISOString()} style={styles.previewRow}>
                        <Text
                          style={[
                            styles.previewIndex,
                            { color: colors.accent },
                          ]}
                        >
                          {index + 1}
                        </Text>
                        <Text style={[styles.caption, { color: colors.muted }]}>
                          {date.toLocaleString(locale, { timeZone: timezone })}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>
          </SectionCard>
          <SectionCard
            title={t("sound")}
            description={copy(
              locale,
              "Choose how this reminder should get your attention.",
              "Escolha como este lembrete deve chamar sua atenção.",
            )}
            colors={colors}
          >
            <View style={styles.chips}>
              {(["default", "silent", "vibrate"] as const).map((mode) => (
                <Button
                  key={mode}
                  label={mode}
                  onPress={() => setSound({ mode })}
                  active={sound.mode === mode}
                  selected={sound.mode === mode}
                  colors={colors}
                  variant="chip"
                  compact
                />
              ))}
              <Button
                label={copy(locale, "Preview sound", "Ouvir prévia")}
                onPress={() => void previewSound(sound)}
                colors={colors}
                variant="secondary"
                compact
              />
            </View>
          </SectionCard>
        </View>
      </View>
      {error && <Notice tone="danger" colors={colors} text={error} />}
      <View
        style={[
          styles.editorActions,
          { borderColor: colors.border, backgroundColor: colors.background },
        ]}
      >
        <Button
          label={t("cancel")}
          onPress={onCancel}
          colors={colors}
          variant="secondary"
        />
        <Button
          label={t("save")}
          onPress={() => void save()}
          colors={colors}
          variant="primary"
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
  const { width } = useWindowDimensions();
  const isWide = width >= 1120;
  const [backupText, setBackupText] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [importConflicts, setImportConflicts] = useState<
    readonly SyncConflict[]
  >([]);
  const [notificationStatus, setNotificationStatus] =
    useState<NotificationRegistrationStatus>("idle");
  const [notificationMessageKey, setNotificationMessageKey] =
    useState<MessageKey | null>(null);

  useEffect(() => {
    let active = true;
    void getRememberedDeviceRegistration()
      .then((registration) => {
        if (!active || !registration) return;
        setNotificationStatus("registered");
        setNotificationMessageKey("notificationsEnabled");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [ownerId]);

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
    if (notificationStatus === "registering") return;
    setNotificationStatus("registering");
    setNotificationMessageKey(null);
    try {
      const registration = await new DeviceNotificationAdapter().register(
        ownerId,
      );
      if (!registration) {
        setNotificationStatus("error");
        setNotificationMessageKey("notificationPermissionDenied");
        return;
      }
      if (!supabase) throw new Error("Supabase is not configured.");
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
      setNotificationStatus("registered");
      setNotificationMessageKey("notificationsEnabled");
    } catch (error) {
      console.error("Notification registration failed.", error);
      setNotificationStatus("error");
      setNotificationMessageKey(notificationErrorMessageKey(error));
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <PageHeader
        eyebrow={copy(locale, "Account", "Conta")}
        title={t("settings")}
        description={copy(
          locale,
          "Manage appearance, notifications, backups, and account access.",
          "Gerencie aparência, notificações, backups e acesso à conta.",
        )}
        colors={colors}
      />
      <View style={[styles.screenGrid, isWide && styles.screenGridWide]}>
        <View style={styles.screenColumn}>
          <SectionCard
            title={copy(locale, "Preferences", "Preferências")}
            description={copy(
              locale,
              "Choose the language and appearance used on this device.",
              "Escolha o idioma e a aparência usados neste dispositivo.",
            )}
            colors={colors}
          >
            <View style={styles.formStack}>
              <View>
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
                    variant="chip"
                  />
                  <Button
                    label="Português (Brasil)"
                    onPress={() => updateLocale("pt-BR")}
                    active={locale === "pt-BR"}
                    selected={locale === "pt-BR"}
                    colors={colors}
                    variant="chip"
                  />
                </View>
              </View>
              <View>
                <Text style={[styles.label, { color: colors.text }]}>
                  {t("theme")}
                </Text>
                <View style={styles.chips}>
                  {(["system", "light", "dark"] as const).map((value) => (
                    <Button
                      key={value}
                      label={
                        value === "system"
                          ? copy(locale, "System", "Sistema")
                          : value === "light"
                            ? copy(locale, "Light", "Claro")
                            : copy(locale, "Dark", "Escuro")
                      }
                      onPress={() => updateTheme(value)}
                      active={theme === value}
                      selected={theme === value}
                      colors={colors}
                      variant="chip"
                    />
                  ))}
                </View>
              </View>
            </View>
          </SectionCard>
          <SectionCard
            title={copy(locale, "Notifications", "Notificações")}
            description={copy(
              locale,
              "Register this device to receive reminders when the app is closed.",
              "Registre este dispositivo para receber lembretes quando o aplicativo estiver fechado.",
            )}
            colors={colors}
          >
            <View style={styles.formStack}>
              <Button
                label={
                  notificationStatus === "registering"
                    ? t("enablingNotifications")
                    : notificationStatus === "registered"
                      ? t("notificationsEnabled")
                      : t("enableNotifications")
                }
                onPress={() => void enableNotifications()}
                colors={colors}
                variant={
                  notificationStatus === "registered" ? "secondary" : "primary"
                }
                loading={notificationStatus === "registering"}
                disabled={notificationStatus === "registering"}
              />
              {notificationMessageKey && (
                <Notice
                  tone={notificationStatus === "error" ? "warning" : "success"}
                  colors={colors}
                  text={t(notificationMessageKey)}
                />
              )}
            </View>
          </SectionCard>
        </View>
        <View style={styles.screenColumn}>
          <SectionCard
            title={copy(locale, "Backup and restore", "Backup e restauração")}
            description={copy(
              locale,
              "Export your reminders or merge a JSON backup into this account.",
              "Exporte seus lembretes ou mescle um backup JSON nesta conta.",
            )}
            colors={colors}
          >
            <View style={styles.formStack}>
              <Button
                label={copy(
                  locale,
                  "Export JSON backup",
                  "Exportar backup JSON",
                )}
                onPress={() => void exportJson()}
                colors={colors}
                variant="secondary"
              />
              <Field
                label={t("importBackupPrompt")}
                value={backupText}
                onChangeText={setBackupText}
                colors={colors}
                multiline
                placeholder={copy(
                  locale,
                  "Paste the JSON backup here",
                  "Cole o backup JSON aqui",
                )}
              />
              <Button
                label={t("importBackup")}
                onPress={() => void importJson()}
                colors={colors}
                variant="primary"
                disabled={!backupText.trim()}
              />
              {backupMessage && (
                <Notice tone="neutral" colors={colors} text={backupMessage} />
              )}
              {importConflicts.map((conflict) => (
                <View
                  key={conflict.id}
                  style={[
                    styles.conflictCard,
                    {
                      borderColor: colors.warning,
                      backgroundColor: colors.warningSoft,
                    },
                  ]}
                >
                  <View style={styles.flex}>
                    <Text style={[styles.cardTitle, { color: colors.text }]}>
                      {conflict.local.title}
                    </Text>
                    <Text style={[styles.body, { color: colors.muted }]}>
                      {copy(
                        locale,
                        "Choose which version to keep.",
                        "Escolha qual versão manter.",
                      )}
                    </Text>
                  </View>
                  <View style={styles.actions}>
                    {(["local", "remote"] as const).map((choice) => (
                      <Button
                        key={choice}
                        label={
                          choice === "local"
                            ? copy(locale, "Keep existing", "Manter existente")
                            : copy(locale, "Keep imported", "Manter importado")
                        }
                        colors={colors}
                        variant="secondary"
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
                            .then(() =>
                              synchronizeReminders(ownerId).catch(() => []),
                            )
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
            </View>
          </SectionCard>
          <SectionCard
            title={copy(locale, "Account access", "Acesso à conta")}
            description={copy(
              locale,
              "Sign out on this device or permanently remove your synchronized data.",
              "Saia neste dispositivo ou remova permanentemente seus dados sincronizados.",
            )}
            colors={colors}
          >
            <View style={styles.accountActions}>
              <Button
                label={t("signOut")}
                onPress={() => void authentication?.signOut()}
                colors={colors}
                variant="secondary"
              />
              <Button
                label={t("deleteAccount")}
                onPress={() =>
                  confirmDestructiveAction(
                    t("deleteAccountTitle"),
                    t("deleteAccountMessage"),
                    t("cancel"),
                    t("deleteAccount"),
                    () => void authentication?.deleteAccount(),
                  )
                }
                colors={colors}
                danger
                variant="danger"
              />
            </View>
          </SectionCard>
        </View>
      </View>
    </ScrollView>
  );
}

function notificationErrorMessageKey(error: unknown): MessageKey {
  if (error instanceof NotificationRegistrationError) {
    if (error.code === "unsupported") return "notificationUnsupported";
    if (error.code === "insecure-context")
      return "notificationSecureContextRequired";
    if (error.code === "missing-vapid-key")
      return "notificationMissingConfiguration";
  }
  return "notificationRegistrationFailed";
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
  placeholder,
  ...props
}: {
  label: string;
  colors: Colors;
  value: string;
  onChangeText: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={colors.subtle}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          props.multiline && styles.multiline,
          {
            color: colors.text,
            borderColor: focused ? colors.focus : colors.borderStrong,
            backgroundColor: colors.surface,
          },
        ]}
        {...props}
      />
    </View>
  );
}

type ButtonVariant =
  "primary" | "secondary" | "ghost" | "danger" | "chip" | "nav";

function Button({
  label,
  onPress,
  colors,
  active,
  selected = false,
  danger,
  compact,
  disabled,
  loading = false,
  variant,
  block = false,
  grow = false,
}: {
  label: string;
  onPress: () => void;
  colors: Colors;
  active?: boolean;
  selected?: boolean;
  danger?: boolean;
  compact?: boolean;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  block?: boolean;
  grow?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const resolvedVariant: ButtonVariant =
    variant ?? (danger ? "danger" : active ? "primary" : "secondary");
  const isSelected = selected || active;
  const isUnavailable = disabled || loading;
  const isPrimary = resolvedVariant === "primary";
  const isDanger = resolvedVariant === "danger";
  const isChip = resolvedVariant === "chip";
  const isNav = resolvedVariant === "nav";
  const backgroundColor = isPrimary
    ? hovered
      ? colors.accentHover
      : colors.accent
    : isDanger
      ? hovered
        ? colors.dangerHover
        : colors.danger
      : (isChip || isNav) && isSelected
        ? colors.accentSoft
        : hovered
          ? colors.surfaceMuted
          : resolvedVariant === "ghost" || isNav
            ? "transparent"
            : colors.surface;
  const textColor =
    isPrimary || isDanger
      ? colors.onAccent
      : (isChip || isNav) && isSelected
        ? colors.accent
        : colors.text;
  const borderColor =
    isPrimary || isDanger
      ? backgroundColor
      : isChip && isSelected
        ? colors.accent
        : resolvedVariant === "ghost" || isNav
          ? "transparent"
          : colors.borderStrong;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        busy: loading,
        disabled: isUnavailable,
        selected: isChip || isNav ? isSelected : undefined,
      }}
      disabled={isUnavailable}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        block && styles.blockButton,
        grow && styles.growButton,
        {
          backgroundColor,
          borderColor: focused ? colors.focus : borderColor,
          opacity: disabled ? 0.48 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
      ]}
    >
      {loading && <ActivityIndicator color={textColor} size="small" />}
      <Text style={[styles.buttonText, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

function BrandMark({ colors }: { colors: Colors }) {
  return (
    <View
      accessible={false}
      style={[styles.brandMark, { backgroundColor: colors.accent }]}
    >
      <View
        style={[styles.brandMarkHand, { backgroundColor: colors.onAccent }]}
      />
      <View
        style={[
          styles.brandMarkHand,
          styles.brandMarkHandShort,
          { backgroundColor: colors.onAccent },
        ]}
      />
    </View>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  colors,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  colors: Colors;
  action?: ReactNode;
}) {
  return (
    <View style={styles.pageHeader}>
      <View style={styles.pageHeaderCopy}>
        <Text style={[styles.eyebrow, { color: colors.accent }]}>
          {eyebrow}
        </Text>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: colors.text }]}
        >
          {title}
        </Text>
        <Text style={[styles.lede, { color: colors.muted }]}>
          {description}
        </Text>
      </View>
      {action && <View style={styles.pageHeaderAction}>{action}</View>}
    </View>
  );
}

function SectionCard({
  title,
  description,
  colors,
  children,
}: {
  title: string;
  description: string;
  colors: Colors;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        styles.sectionCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={styles.sectionCardHeader}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          {description}
        </Text>
      </View>
      <View
        style={[styles.sectionDivider, { backgroundColor: colors.border }]}
      />
      {children}
    </View>
  );
}

function Notice({
  tone,
  colors,
  text,
  children,
}: {
  tone: "neutral" | "success" | "warning" | "danger";
  colors: Colors;
  text: string;
  children?: ReactNode;
}) {
  const toneColor =
    tone === "success"
      ? colors.success
      : tone === "warning"
        ? colors.warning
        : tone === "danger"
          ? colors.danger
          : colors.muted;
  const toneSurface =
    tone === "success"
      ? colors.successSoft
      : tone === "warning"
        ? colors.warningSoft
        : tone === "danger"
          ? colors.dangerSoft
          : colors.surfaceMuted;
  return (
    <View
      accessibilityRole={
        tone === "danger" || tone === "warning" ? "alert" : undefined
      }
      style={[
        styles.notice,
        { backgroundColor: toneSurface, borderColor: toneColor },
      ]}
    >
      <View style={[styles.noticeMark, { backgroundColor: toneColor }]} />
      <View style={styles.flex}>
        <Text style={[styles.noticeText, { color: colors.text }]}>{text}</Text>
        {children}
      </View>
    </View>
  );
}

function StatusBadge({
  label,
  tone,
  colors,
}: {
  label: string;
  tone: "success" | "warning" | "neutral";
  colors: Colors;
}) {
  const textColor =
    tone === "success"
      ? colors.success
      : tone === "warning"
        ? colors.warning
        : colors.muted;
  const backgroundColor =
    tone === "success"
      ? colors.successSoft
      : tone === "warning"
        ? colors.warningSoft
        : colors.surfaceMuted;
  return (
    <View style={[styles.badge, { backgroundColor }]}>
      <View style={[styles.badgeDot, { backgroundColor: textColor }]} />
      <Text style={[styles.badgeText, { color: textColor }]}>{label}</Text>
    </View>
  );
}

function EmptyState({
  title,
  message,
  colors,
  action,
}: {
  title: string;
  message: string;
  colors: Colors;
  action?: ReactNode;
}) {
  return (
    <View
      style={[
        styles.empty,
        {
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
      ]}
    >
      <View style={[styles.emptyMark, { backgroundColor: colors.accentSoft }]}>
        <View
          style={[styles.emptyMarkLine, { backgroundColor: colors.accent }]}
        />
        <View
          style={[
            styles.emptyMarkLine,
            styles.emptyMarkLineShort,
            { backgroundColor: colors.accent },
          ]}
        />
      </View>
      <Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>{message}</Text>
      {action}
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
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.body, { color: colors.muted }]}>{text}</Text>
    </SafeAreaView>
  );
}

function copy(locale: Locale, english: string, portuguese: string): string {
  return locale === "pt-BR" ? portuguese : english;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  shell: { flex: 1 },
  wideShell: { flexDirection: "row" },
  navigation: {
    padding: space.lg,
    gap: space.lg,
    zIndex: 2,
  },
  sideNavigation: {
    width: size.navigationWide,
    borderRightWidth: 1,
    paddingVertical: space.xl,
  },
  topNavigation: {
    borderBottomWidth: 1,
    paddingVertical: space.md,
  },
  brandLockup: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  brandCopy: { minWidth: 0, flex: 1 },
  brandMark: {
    width: size.controlSm,
    height: size.controlSm,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkHand: {
    position: "absolute",
    width: space.xs,
    height: space.md,
    borderRadius: radius.pill,
    transform: [{ translateY: -space.xs }],
  },
  brandMarkHandShort: {
    height: space.sm,
    transform: [
      { translateX: space.xs },
      { translateY: space.xs },
      { rotate: "-45deg" },
    ],
  },
  brand: {
    fontSize: type.title,
    lineHeight: type.bodyLine,
    fontWeight: "700",
    letterSpacing: -0.35,
  },
  brandMeta: {
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "500",
  },
  navItems: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  navItemsWide: {
    width: "100%",
    flexDirection: "column",
    flexWrap: "nowrap",
  },
  content: { flex: 1 },
  page: {
    width: "100%",
    maxWidth: size.contentMax,
    alignSelf: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space["3xl"],
    gap: space.xl,
  },
  screenGrid: {
    width: "100%",
    gap: space.xl,
  },
  screenGridWide: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  screenColumn: {
    flex: 1,
    minWidth: 0,
    gap: space.xl,
  },
  editorDetailsColumn: { flex: 0.9 },
  editorScheduleColumn: { flex: 1.1 },
  listHeader: { gap: space.xl, marginBottom: space.xl },
  center: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: space.md,
  },
  pageHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.xl,
    paddingVertical: space.md,
  },
  pageHeaderCopy: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: size.readable,
    gap: space.sm,
  },
  pageHeaderAction: { flexShrink: 0 },
  eyebrow: {
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  heading: {
    fontSize: type.display,
    lineHeight: type.displayLine,
    fontWeight: "700",
    letterSpacing: -1.2,
  },
  lede: {
    maxWidth: size.readable,
    fontSize: type.body,
    lineHeight: type.bodyLine,
  },
  cardTitle: {
    fontSize: type.title,
    lineHeight: type.bodyLine,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  body: { fontSize: type.body, lineHeight: type.bodyLine },
  caption: { fontSize: type.caption, lineHeight: type.captionLine },
  label: {
    fontSize: type.label,
    lineHeight: type.captionLine,
    fontWeight: "700",
    marginBottom: space.sm,
  },
  sectionLabel: {
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "700",
    letterSpacing: 0.65,
    textTransform: "uppercase",
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  sectionCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.xl,
    gap: space.xl,
  },
  sectionCardHeader: { maxWidth: size.readable, gap: space.xs },
  sectionDivider: { width: "100%", height: 1 },
  formStack: { gap: space.lg },
  field: { minWidth: 0 },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.lg,
  },
  flex: { flex: 1, minWidth: 0 },
  input: {
    width: "100%",
    minWidth: 0,
    minHeight: size.controlLg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    fontSize: type.body,
  },
  multiline: {
    minHeight: size.controlLg * 2,
    paddingTop: space.md,
    paddingBottom: space.md,
    textAlignVertical: "top",
  },
  button: {
    minHeight: size.controlMd,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  compactButton: {
    minHeight: size.controlSm,
    paddingHorizontal: space.md,
  },
  blockButton: {
    width: "100%",
    alignItems: "flex-start",
  },
  growButton: { flexGrow: 1 },
  buttonText: {
    fontSize: type.label,
    lineHeight: type.captionLine,
    fontWeight: "700",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  accountActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: space.md,
  },
  controlPanel: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.lg,
  },
  filterGroup: { gap: space.sm },
  reminderCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.xl,
    gap: space.lg,
  },
  reminderTitleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.xs,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.xs,
    marginTop: space.sm,
  },
  tag: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "600",
  },
  badge: {
    minHeight: space["2xl"],
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  badgeDot: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "700",
  },
  conflictCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.lg,
  },
  notice: {
    minHeight: size.controlMd,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
  },
  noticeMark: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.pill,
    marginTop: space.sm,
  },
  noticeText: {
    fontSize: type.label,
    lineHeight: type.bodyLine,
    fontWeight: "600",
  },
  empty: {
    borderWidth: 1,
    borderRadius: radius.lg,
    minHeight: 280,
    padding: space["3xl"],
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
  },
  emptyMark: {
    width: size.controlLg,
    height: size.controlLg,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  emptyMarkLine: {
    width: space["2xl"],
    height: space.xs,
    borderRadius: radius.pill,
  },
  emptyMarkLineShort: {
    width: space.md,
    marginTop: space.sm,
  },
  emptyBody: {
    maxWidth: 420,
    textAlign: "center",
    fontSize: type.body,
    lineHeight: type.bodyLine,
    marginBottom: space.sm,
  },
  preview: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.md,
  },
  previewList: { gap: space.sm },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  previewIndex: {
    width: space.xl,
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  editorActions: {
    borderTopWidth: 1,
    paddingTop: space.xl,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: space.sm,
  },
  historyRow: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  timelineMarker: {
    width: space.md,
    height: space.md,
    borderRadius: radius.pill,
  },
  authShell: {
    flex: 1,
    justifyContent: "flex-start",
    padding: space.lg,
  },
  authShellWide: { justifyContent: "center" },
  authLayout: {
    width: "100%",
    maxWidth: 1080,
    alignSelf: "center",
    gap: space["3xl"],
  },
  authLayoutWide: {
    flexDirection: "row",
    alignItems: "center",
    gap: space["6xl"],
  },
  authIntro: {
    flex: 1,
    minWidth: 0,
    gap: space.xl,
  },
  authIntroWide: { paddingRight: space.xl },
  authHeading: {
    maxWidth: 620,
    fontSize: type.display,
    lineHeight: type.displayLine,
    fontWeight: "700",
    letterSpacing: -1.2,
  },
  authHeadingWide: {
    fontSize: type.displayLarge,
    lineHeight: type.displayLargeLine,
    letterSpacing: -1.6,
  },
  authBody: {
    maxWidth: 580,
    fontSize: type.title,
    lineHeight: type.headingLine,
  },
  authFeatureList: { gap: space.md },
  authFeature: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  featureMark: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.pill,
  },
  authCard: {
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space["2xl"],
    gap: space.lg,
  },
  authCardTitle: {
    fontSize: type.heading,
    lineHeight: type.headingLine,
    fontWeight: "700",
    letterSpacing: -0.65,
  },
  authActions: { gap: space.sm },
});
