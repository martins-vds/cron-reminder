import AsyncStorage from "@react-native-async-storage/async-storage";
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

export const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          storage: AsyncStorage,
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
let tombstoneQueue = Promise.resolve();
let synchronizationQueue = Promise.resolve();

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
        const deviceId = await AsyncStorage.getItem(deviceKey);
        if (deviceId) {
          const { error: deviceError } = await supabase
            .from("devices")
            .delete()
            .eq("id", deviceId);
          if (!deviceError) await AsyncStorage.removeItem(deviceKey);
        }
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      },
      async deleteAccount() {
        const { data: userData } = await supabase.auth.getUser();
        const ownerId = userData.user?.id;
        const { error } = await supabase.functions.invoke("delete-account");
        if (error) throw error;
        if (ownerId) {
          const reminders = await localRepository.list(ownerId);
          for (const reminder of reminders) {
            await localRepository.delete(reminder.id);
          }
        }
        await AsyncStorage.removeItem(deletedKey);
        await AsyncStorage.removeItem(deviceKey);
        await supabase.auth.signOut();
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

export async function rememberDevice(id: string): Promise<void> {
  await AsyncStorage.setItem(deviceKey, id);
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
): Promise<void> {
  if (!supabase) return;
  const body =
    action === "snooze"
      ? { occurrenceId, action, minutes: 10 }
      : { occurrenceId, action };
  const { error } = await supabase.functions.invoke("occurrence-action", {
    body,
  });
  if (error) throw error;
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
