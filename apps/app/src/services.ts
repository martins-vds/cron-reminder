import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@supabase/supabase-js";
import { makeRedirectUri } from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import {
  JsonReminderRepository,
  OfflineSynchronizationAdapter,
  SupabaseReminderRepository,
  JsonCategoryRepository,
  SupabaseCategoryRepository,
  synchronizeCategories,
  clearDeletedCategoryAssignments,
  SupabaseAnalyticsRepository,
  type DatabaseClient,
} from "@cron-reminder/infrastructure";
import type {
  AuthenticationPort,
  SyncConflict,
  CategoryConflict,
} from "@cron-reminder/application";
import { CategoryService } from "@cron-reminder/application";
import type {
  NotificationAction,
  Postponement,
  Reminder,
  AnalyticsSnapshot,
} from "@cron-reminder/domain";
import { AppState, Platform } from "react-native";

export const localRepository = new JsonReminderRepository({
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
});
export const categoryRepository = new JsonCategoryRepository({
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
});
const categoryService = new CategoryService(
  categoryRepository,
  () => new Date().toISOString(),
  () => `category-${Crypto.randomUUID()}`,
);
const dataListeners = new Set<() => void>();
const categoryConflicts = new Map<string, CategoryConflict[]>();
export function subscribeToDataChanges(listener: () => void): () => void {
  dataListeners.add(listener);
  return () => {
    dataListeners.delete(listener);
  };
}
function dataChanged() {
  for (const listener of dataListeners) listener();
}
export async function cachedAnalytics(
  ownerId: string,
): Promise<AnalyticsSnapshot | null> {
  const value = await AsyncStorage.getItem(
    `cron-reminder:analytics:${ownerId}`,
  );
  return value ? (JSON.parse(value) as AnalyticsSnapshot) : null;
}
export async function loadAnalytics(
  ownerId: string,
): Promise<AnalyticsSnapshot> {
  return withSynchronization(async () => {
    if (!supabase) throw new Error("analyticsConnectionRequired");
    const snapshot = await new SupabaseAnalyticsRepository(databaseClient).load(
      ownerId,
    );
    const reminders = await localRepository.list(ownerId);
    const existing = new Set(reminders.map((item) => item.id));
    snapshot.days = snapshot.days.filter((item) =>
      existing.has(item.reminderId),
    );
    await AsyncStorage.setItem(
      `cron-reminder:analytics:${ownerId}`,
      JSON.stringify(snapshot),
    );
    return snapshot;
  });
}
export function getCategoryConflicts(
  ownerId: string,
): readonly CategoryConflict[] {
  return categoryConflicts.get(ownerId) ?? [];
}
export async function saveCategory(
  ownerId: string,
  name: string,
  id?: string,
): Promise<void> {
  await withSynchronization(async () => {
    await categoryRepository.initialize(ownerId);
    await categoryService.save(ownerId, name, id);
    dataChanged();
  });
}
export async function removeCategory(
  ownerId: string,
  id: string,
): Promise<void> {
  await withSynchronization(async () => {
    await categoryService.remove(ownerId, id);
    await clearDeletedCategoryAssignments(
      ownerId,
      categoryRepository,
      localRepository,
    );
    dataChanged();
  });
}
export async function resolveCategoryConflict(
  ownerId: string,
  conflict: CategoryConflict,
  choice: "local" | "remote",
): Promise<void> {
  await withSynchronization(async () => {
    if (!supabase) throw new Error("categoryConnectionRequired");
    if (choice === "local") {
      const resolved = {
        ...conflict.local,
        revision:
          Math.max(conflict.local.revision, conflict.remote.revision) + 1,
      };
      await new SupabaseCategoryRepository(databaseClient).save(
        resolved,
        conflict.remote.revision,
      );
      await categoryRepository.acknowledge(resolved);
    } else {
      await categoryRepository.acknowledge(conflict.remote);
    }
    categoryConflicts.set(
      ownerId,
      getCategoryConflicts(ownerId).filter(
        (item) => item.local.id !== conflict.local.id,
      ),
    );
    dataChanged();
  });
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const secureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

const authStorage = Platform.OS === "web" ? AsyncStorage : secureStoreAdapter;

export const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          storage: authStorage,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
          persistSession: true,
        },
      })
    : null;

const databaseClient: DatabaseClient = {
  async readPage(table, ownerId, order, offset, limit) {
    if (!supabase) throw new Error("Connect to load synchronized data.");
    let query = supabase.from(table).select("*").eq("owner_id", ownerId);
    for (const column of order) query = query.order(column);
    const result = await query.range(offset, offset + limit - 1);
    return { data: result.data, error: result.error };
  },
  async rpc(name, args) {
    if (!supabase) throw new Error("Connect to synchronize data.");
    const { data, error } = await supabase.rpc(name, args);
    return { data, error };
  },
};

if (supabase && Platform.OS !== "web") {
  if (AppState.currentState === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
  AppState.addEventListener("change", (state) => {
    if (state === "active") supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

WebBrowser.maybeCompleteAuthSession();

const redirectTo = makeRedirectUri({
  scheme: "cron-reminder",
  path: "auth/callback",
});
const deviceKey = "cron-reminder:device-id";
const deletedKey = "cron-reminder:deleted";
const notificationActionsKey = "cron-reminder:notification-actions";
const pendingDeviceDeregistrationsKey =
  "cron-reminder:pending-device-deregistrations";
const pendingPushTokenKey = "cron-reminder:pending-push-token";
let tombstoneQueue = Promise.resolve();
let synchronizationQueue = Promise.resolve();
let notificationActionQueue = Promise.resolve();
let notificationActionFlushQueue = Promise.resolve();
let deviceDeregistrationQueue = Promise.resolve();
let pushTokenQueue = Promise.resolve();

interface PendingNotificationAction {
  actionId: string;
  occurrenceId: string;
  action: NotificationAction;
  ownerId: string;
  queuedAt?: string;
  until?: string;
  mergeIntoNext?: boolean;
}

interface DeviceRegistrationRecord {
  id: string;
  token: string;
}

interface StoredDeviceRegistration {
  id: string;
  token?: string;
}

interface PendingPushToken {
  ownerId: string;
  token: string;
}

export const authentication: AuthenticationPort | null = supabase
  ? {
      async currentUser() {
        const { data } = await supabase.auth.getUser();
        return data.user ? { id: data.user.id } : null;
      },
      async signIn(provider) {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo,
            skipBrowserRedirect: Platform.OS !== "web",
          },
        });
        if (error) throw error;
        if (Platform.OS !== "web" && data.url) {
          const result = await WebBrowser.openAuthSessionAsync(
            data.url,
            redirectTo,
          );
          if (result.type !== "success") return;
          const code = new URL(result.url).searchParams.get("code");
          if (!code) throw new Error("OAuth callback did not include a code.");
          const exchange = await supabase.auth.exchangeCodeForSession(code);
          if (exchange.error) throw exchange.error;
        }
      },
      async signOut() {
        const device = await readDeviceRegistration();
        if (device?.token) {
          await queueDeviceDeregistration({
            id: device.id,
            token: device.token,
          });
          await flushPendingDeviceDeregistrations();
        } else if (device) {
          await supabase.from("devices").delete().eq("id", device.id);
        }
        await clearPendingPushTokenUpdate();
        await AsyncStorage.removeItem(deviceKey);
        const { error } = await supabase.auth.signOut();
        if (error) {
          const { error: localError } = await supabase.auth.signOut({
            scope: "local",
          });
          if (localError) throw localError;
        }
      },
      async deleteAccount() {
        const { data: userData } = await supabase.auth.getUser();
        const ownerId = userData.user?.id;
        const device = await readDeviceRegistration();
        await withSynchronization(async () => {
          const { error } = await supabase.functions.invoke("delete-account");
          if (error) throw error;
          if (ownerId) {
            await categoryRepository.clear(ownerId);
            await AsyncStorage.removeItem(`cron-reminder:analytics:${ownerId}`);
            categoryConflicts.delete(ownerId);
            const reminders = await localRepository.list(ownerId);
            for (const reminder of reminders) {
              await localRepository.delete(ownerId, reminder.id);
            }
            await withTombstones(async () => {
              const remaining = (await readDeleted()).filter(
                (item) => item.ownerId !== ownerId,
              );
              if (remaining.length) {
                await AsyncStorage.setItem(
                  deletedKey,
                  JSON.stringify(remaining),
                );
              } else {
                await AsyncStorage.removeItem(deletedKey);
              }
            });
            await withNotificationActions(async () => {
              await writeNotificationActions(
                (await readNotificationActions()).filter(
                  (item) => item.ownerId !== ownerId,
                ),
              );
            });
          }
          await AsyncStorage.removeItem(deviceKey);
          await clearPendingPushTokenUpdate(ownerId);
          await removePendingDeviceDeregistration(device?.id);
          const { error: signOutError } = await supabase.auth.signOut();
          if (signOutError) {
            const { error: localError } = await supabase.auth.signOut({
              scope: "local",
            });
            if (localError) throw localError;
          }
        });
      },
    }
  : null;

export const synchronization = supabase
  ? new OfflineSynchronizationAdapter(
      localRepository,
      new SupabaseReminderRepository(
        supabase as unknown as ConstructorParameters<
          typeof SupabaseReminderRepository
        >[0],
      ),
    )
  : null;

export async function rememberDevice(
  id: string,
  token: string,
  currentPushToken?: PendingPushToken,
): Promise<void> {
  await withPushToken(async () => {
    await AsyncStorage.setItem(deviceKey, JSON.stringify({ id, token }));
    if (currentPushToken)
      await AsyncStorage.setItem(
        pendingPushTokenKey,
        JSON.stringify(currentPushToken),
      );
  });
  await flushPendingPushTokenUpdate();
}

export async function getRememberedDeviceId(): Promise<string | null> {
  return (await readDeviceRegistration())?.id ?? null;
}

export async function getRememberedDeviceRegistration(): Promise<StoredDeviceRegistration | null> {
  return readDeviceRegistration();
}

async function readDeviceNotificationRegistration(
  ownerId: string,
  deviceId: string,
) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("devices")
    .select("enabled,token,user_disabled")
    .eq("id", deviceId)
    .eq("owner_id", ownerId)
    .maybeSingle<{
      enabled: boolean;
      token: string;
      user_disabled: boolean;
    }>();
  if (error) throw error;
  return data;
}

export async function isRememberedDeviceRegistered(
  ownerId: string,
  currentToken?: string | null,
): Promise<boolean> {
  const device = await readDeviceRegistration();
  if (!device || currentToken === null) return false;
  const data = await readDeviceNotificationRegistration(ownerId, device.id);
  return (
    data?.enabled === true &&
    (currentToken === undefined || data.token === currentToken)
  );
}

export async function shouldRenewBrowserSubscription(
  ownerId: string,
  currentToken: string,
): Promise<boolean> {
  const device = await readDeviceRegistration();
  if (!device) return true;
  const registration = await readDeviceNotificationRegistration(
    ownerId,
    device.id,
  );
  if (
    registration?.user_disabled === true &&
    registration.token === currentToken
  )
    return false;
  return !(
    registration?.enabled === true && registration.token === currentToken
  );
}

export async function disableDeviceNotifications(
  ownerId: string,
): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  await withPushToken(async () => {
    const device = await readDeviceRegistration();
    if (!device) throw new Error("No device registration was found.");
    const { data, error } = await supabase
      .from("devices")
      .update({
        enabled: false,
        user_disabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", device.id)
      .eq("owner_id", ownerId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data)
      throw new Error("The device registration could not be disabled.");
    await AsyncStorage.removeItem(pendingPushTokenKey);
  });
}

export async function updateRememberedDeviceToken(
  ownerId: string,
  token: string,
): Promise<void> {
  await withPushToken(async () => {
    await AsyncStorage.setItem(
      pendingPushTokenKey,
      JSON.stringify({ ownerId, token }),
    );
  });
  await flushPendingPushTokenUpdate();
}

export async function flushPendingPushTokenUpdate(): Promise<void> {
  if (!supabase) return;
  await withPushToken(async () => {
    const pending = await readPendingPushToken();
    const device = await readDeviceRegistration();
    if (!pending || !device?.token) return;
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    if (userData.user?.id !== pending.ownerId) {
      await AsyncStorage.removeItem(pendingPushTokenKey);
      return;
    }
    const registration = await readDeviceNotificationRegistration(
      pending.ownerId,
      device.id,
    );
    if (registration?.user_disabled === true) {
      await AsyncStorage.removeItem(pendingPushTokenKey);
      return;
    }
    if (Platform.OS === "web") {
      if (
        registration?.enabled === false &&
        registration.token === pending.token
      )
        throw new Error(
          "This browser subscription was rejected. Enable notifications again to replace it.",
        );
    }
    const { data, error } = await supabase.rpc("claim_device_token", {
      p_device_id: device.id,
      p_platform:
        Platform.OS === "web"
          ? "web"
          : Platform.OS === "ios"
            ? "ios"
            : "android",
      p_token: pending.token,
      p_deregistration_token: device.token,
      p_existing_deregistration_token: device.token,
      p_enable: false,
    });
    if (error) throw error;
    if (!data) throw new Error("Unable to refresh the device push token.");
    await AsyncStorage.removeItem(pendingPushTokenKey);
  });
}

export async function flushPendingDeviceDeregistrations(): Promise<void> {
  if (!supabase) return;
  await withDeviceDeregistrations(async () => {
    let pending = await readPendingDeviceDeregistrations();
    for (const device of pending) {
      const { error } = await supabase.functions.invoke("deregister-device", {
        body: device,
      });
      if (error) return;
      pending = pending.filter((item) => item.id !== device.id);
      await writePendingDeviceDeregistrations(pending);
    }
  });
}

export async function deleteReminder(
  id: string,
  ownerId: string,
): Promise<void> {
  await withSynchronization(async () => {
    await withTombstones(async () => {
      const deleted = await readDeleted();
      if (!deleted.some((item) => item.id === id && item.ownerId === ownerId))
        deleted.push({ id, ownerId });
      await AsyncStorage.setItem(deletedKey, JSON.stringify(deleted));
    });
    await localRepository.delete(ownerId, id);
    await AsyncStorage.removeItem(`cron-reminder:analytics:${ownerId}`);
    dataChanged();
    void flushDeletedReminders(ownerId).catch(() => {});
  });
}

export async function flushDeletedReminders(ownerId: string): Promise<void> {
  if (!supabase) return;
  await withTombstones(async () => {
    const deleted = await readDeleted();
    const mine = deleted.filter((item) => item.ownerId === ownerId);
    if (!mine.length) return;
    const ids = mine.map(({ id }) => id);
    const { error: tombstoneError } = await supabase
      .from("reminder_tombstones")
      .upsert(mine.map(({ id }) => ({ id, owner_id: ownerId })));
    if (tombstoneError) throw tombstoneError;
    const { error } = await supabase
      .from("reminders")
      .delete()
      .eq("owner_id", ownerId)
      .in("id", ids);
    if (error) throw error;
    const latest = await readDeleted();
    await AsyncStorage.setItem(
      deletedKey,
      JSON.stringify(
        latest.filter(
          (item) => item.ownerId !== ownerId || !ids.includes(item.id),
        ),
      ),
    );
  });
}

export async function submitNotificationAction(
  occurrenceId: string,
  action: NotificationAction,
  ownerId: string,
  postponement?: Postponement,
  actionId?: string,
): Promise<void> {
  if (action === "snooze" && !postponement)
    throw new Error("Choose a postponement time.");
  const logicalId = actionId ?? Crypto.randomUUID();
  await withNotificationActions(async () => {
    const pending = await readNotificationActions();
    if (
      !pending.some(
        (item) => item.actionId === logicalId && item.ownerId === ownerId,
      )
    ) {
      pending.push({
        actionId: logicalId,
        occurrenceId,
        action,
        ownerId,
        queuedAt: new Date().toISOString(),
        ...(postponement
          ? {
              until: postponement.until,
              mergeIntoNext: postponement.mergeIntoNext,
            }
          : {}),
      });
      await writeNotificationActions(pending);
      dataChanged();
    }
  });
  await flushNotificationActions(ownerId);
}

export async function getPendingNotificationActions(
  ownerId: string,
): Promise<PendingNotificationAction[]> {
  return withNotificationActions(async () =>
    (await readNotificationActions()).filter(
      (item) => item.ownerId === ownerId,
    ),
  );
}

export async function flushNotificationActions(ownerId: string): Promise<void> {
  if (!supabase) return;
  return withNotificationActionFlush(async () => {
    for (;;) {
      const item = await withNotificationActions(async () =>
        (await readNotificationActions()).find(
          (value) => value.ownerId === ownerId,
        ),
      );
      if (!item) return;
      const body =
        item.action === "snooze"
          ? {
              actionId: item.actionId,
              occurrenceId: item.occurrenceId,
              action: item.action,
              ...(item.until ? { until: item.until } : { minutes: 10 }),
            }
          : {
              occurrenceId: item.occurrenceId,
              action: item.action,
              actionId: item.actionId,
            };
      const { error } = await supabase.functions.invoke("occurrence-action", {
        body,
      });
      if (error && !isTerminalNotificationActionError(error)) return;
      await withNotificationActions(async () => {
        await writeNotificationActions(
          (await readNotificationActions()).filter(
            (value) =>
              value.actionId !== item.actionId ||
              value.ownerId !== item.ownerId,
          ),
        );
      });
      dataChanged();
      if (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "context" in error &&
          error.context instanceof Response
        ) {
          const payload: unknown = await error.context.clone().json();
          if (
            typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof payload.error === "string"
          )
            throw new Error(payload.error);
        }
        throw error;
      }
    }
  });
}

export async function synchronizeReminders(
  ownerId: string,
  portuguese = false,
): Promise<readonly SyncConflict[]> {
  if (!synchronization) return [];
  return withSynchronization(async () => {
    await flushDeletedReminders(ownerId);
    if (supabase) {
      categoryConflicts.set(
        ownerId,
        await synchronizeCategories(
          ownerId,
          categoryRepository,
          new SupabaseCategoryRepository(databaseClient),
          localRepository,
          portuguese,
        ),
      );
    }
    const conflicts = await synchronization.synchronize(ownerId);
    dataChanged();
    return conflicts;
  });
}

export function runReminderMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return withSynchronization(operation);
}

export async function resolveSynchronizationConflict(
  conflict: SyncConflict,
  resolution: Reminder,
): Promise<void> {
  if (!synchronization) return;
  await withSynchronization(() =>
    synchronization.resolve(conflict, resolution),
  );
}

async function readDeleted(): Promise<Array<{ id: string; ownerId: string }>> {
  const value = await AsyncStorage.getItem(deletedKey);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is { id: string; ownerId: string } =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).ownerId === "string",
  );
}

async function readNotificationActions(): Promise<PendingNotificationAction[]> {
  const value = await AsyncStorage.getItem(notificationActionsKey);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  const valid = parsed.filter(
    (
      item,
    ): item is Omit<PendingNotificationAction, "actionId"> & {
      actionId?: string;
    } =>
      typeof item === "object" &&
      item !== null &&
      ((item as Record<string, unknown>).actionId === undefined ||
        (typeof (item as Record<string, unknown>).actionId === "string" &&
          String((item as Record<string, unknown>).actionId).length > 0)) &&
      typeof (item as Record<string, unknown>).occurrenceId === "string" &&
      ((item as Record<string, unknown>).action === "dismiss" ||
        (item as Record<string, unknown>).action === "complete" ||
        (item as Record<string, unknown>).action === "snooze") &&
      typeof (item as Record<string, unknown>).ownerId === "string",
  );
  const actions = valid.map((item) => ({
    ...item,
    actionId: item.actionId ?? Crypto.randomUUID(),
  }));
  if (valid.some((item) => !item.actionId))
    await writeNotificationActions(actions);
  return actions;
}

async function writeNotificationActions(
  actions: readonly PendingNotificationAction[],
): Promise<void> {
  if (actions.length) {
    await AsyncStorage.setItem(notificationActionsKey, JSON.stringify(actions));
  } else {
    await AsyncStorage.removeItem(notificationActionsKey);
  }
}

async function readDeviceRegistration(): Promise<StoredDeviceRegistration | null> {
  const value = await AsyncStorage.getItem(deviceKey);
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).id === "string" &&
      typeof (parsed as Record<string, unknown>).token === "string"
    ) {
      return parsed as DeviceRegistrationRecord;
    }
  } catch {
    return { id: value };
  }
  return { id: value };
}

async function readPendingPushToken(): Promise<PendingPushToken | null> {
  const value = await AsyncStorage.getItem(pendingPushTokenKey);
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).ownerId !== "string" ||
    typeof (parsed as Record<string, unknown>).token !== "string"
  ) {
    return null;
  }
  return parsed as PendingPushToken;
}

async function clearPendingPushTokenUpdate(ownerId?: string): Promise<void> {
  await withPushToken(async () => {
    const pending = await readPendingPushToken();
    if (!pending || ownerId === undefined || pending.ownerId === ownerId) {
      await AsyncStorage.removeItem(pendingPushTokenKey);
    }
  });
}

async function queueDeviceDeregistration(
  device: DeviceRegistrationRecord,
): Promise<void> {
  await withDeviceDeregistrations(async () => {
    const pending = (await readPendingDeviceDeregistrations()).filter(
      ({ id }) => id !== device.id,
    );
    pending.push(device);
    await writePendingDeviceDeregistrations(pending);
  });
}

async function removePendingDeviceDeregistration(
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  await withDeviceDeregistrations(async () => {
    await writePendingDeviceDeregistrations(
      (await readPendingDeviceDeregistrations()).filter(
        (item) => item.id !== id,
      ),
    );
  });
}

async function readPendingDeviceDeregistrations(): Promise<
  DeviceRegistrationRecord[]
> {
  const value = await AsyncStorage.getItem(pendingDeviceDeregistrationsKey);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is DeviceRegistrationRecord =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).token === "string",
  );
}

async function writePendingDeviceDeregistrations(
  devices: readonly DeviceRegistrationRecord[],
): Promise<void> {
  if (devices.length) {
    await AsyncStorage.setItem(
      pendingDeviceDeregistrationsKey,
      JSON.stringify(devices),
    );
  } else {
    await AsyncStorage.removeItem(pendingDeviceDeregistrationsKey);
  }
}

function isTerminalNotificationActionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("context" in error))
    return false;
  const context = (error as { context?: unknown }).context;
  if (
    typeof context !== "object" ||
    context === null ||
    !("status" in context)
  ) {
    return false;
  }
  const status = (context as { status?: unknown }).status;
  return status === 400 || status === 404 || status === 409;
}

function withTombstones<T>(operation: () => Promise<T>): Promise<T> {
  const result = tombstoneQueue.then(operation, operation);
  tombstoneQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withSynchronization<T>(operation: () => Promise<T>): Promise<T> {
  const result = synchronizationQueue.then(operation, operation);
  synchronizationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withNotificationActions<T>(operation: () => Promise<T>): Promise<T> {
  const result = notificationActionQueue.then(operation, operation);
  notificationActionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withNotificationActionFlush<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = notificationActionFlushQueue.then(operation, operation);
  notificationActionFlushQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withDeviceDeregistrations<T>(operation: () => Promise<T>): Promise<T> {
  const result = deviceDeregistrationQueue.then(operation, operation);
  deviceDeregistrationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withPushToken<T>(operation: () => Promise<T>): Promise<T> {
  const result = pushTokenQueue.then(operation, operation);
  pushTokenQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
