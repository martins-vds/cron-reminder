import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@supabase/supabase-js";
import { makeRedirectUri } from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import {
  JsonReminderRepository,
  OfflineSynchronizationAdapter,
  SupabaseReminderRepository,
} from "@cron-reminder/infrastructure";
import type {
  AuthenticationPort,
  SyncConflict,
} from "@cron-reminder/application";
import type { Reminder } from "@cron-reminder/domain";
import { Platform } from "react-native";

export const localRepository = new JsonReminderRepository({
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
});

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
let tombstoneQueue = Promise.resolve();
let synchronizationQueue = Promise.resolve();
let notificationActionQueue = Promise.resolve();
let notificationActionFlushQueue = Promise.resolve();
let deviceDeregistrationQueue = Promise.resolve();

interface PendingNotificationAction {
  occurrenceId: string;
  action: "dismiss" | "snooze";
  ownerId: string;
}

interface DeviceRegistrationRecord {
  id: string;
  token: string;
}

interface StoredDeviceRegistration {
  id: string;
  token?: string;
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
            const reminders = await localRepository.list(ownerId);
            for (const reminder of reminders) {
              await localRepository.delete(reminder.id);
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
          await removePendingDeviceDeregistration(device?.id);
          await supabase.auth.signOut();
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

export async function rememberDevice(id: string, token: string): Promise<void> {
  await AsyncStorage.setItem(deviceKey, JSON.stringify({ id, token }));
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
      if (!deleted.some((item) => item.id === id))
        deleted.push({ id, ownerId });
      await AsyncStorage.setItem(deletedKey, JSON.stringify(deleted));
    });
    await localRepository.delete(id);
    await flushDeletedReminders(ownerId);
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
    const { error } = await supabase.from("reminders").delete().in("id", ids);
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
  action: "dismiss" | "snooze",
  ownerId: string,
): Promise<void> {
  await withNotificationActions(async () => {
    const pending = await readNotificationActions();
    if (
      !pending.some(
        (item) =>
          item.occurrenceId === occurrenceId &&
          item.action === action &&
          item.ownerId === ownerId,
      )
    ) {
      pending.push({ occurrenceId, action, ownerId });
      await writeNotificationActions(pending);
    }
  });
  await flushNotificationActions(ownerId);
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
              occurrenceId: item.occurrenceId,
              action: item.action,
              minutes: 10,
            }
          : { occurrenceId: item.occurrenceId, action: item.action };
      const { error } = await supabase.functions.invoke("occurrence-action", {
        body,
      });
      if (error && !isTerminalNotificationActionError(error)) return;
      await withNotificationActions(async () => {
        await writeNotificationActions(
          (await readNotificationActions()).filter(
            (value) =>
              value.occurrenceId !== item.occurrenceId ||
              value.action !== item.action ||
              value.ownerId !== item.ownerId,
          ),
        );
      });
    }
  });
}

export async function synchronizeReminders(
  ownerId: string,
): Promise<readonly SyncConflict[]> {
  if (!synchronization) return [];
  return withSynchronization(async () => {
    await flushDeletedReminders(ownerId);
    return synchronization.synchronize(ownerId);
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
  return parsed.filter(
    (item): item is PendingNotificationAction =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).occurrenceId === "string" &&
      ((item as Record<string, unknown>).action === "dismiss" ||
        (item as Record<string, unknown>).action === "snooze") &&
      typeof (item as Record<string, unknown>).ownerId === "string",
  );
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
  return status === 400 || status === 404;
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
