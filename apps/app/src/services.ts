import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import {
  JsonReminderRepository,
  OfflineSynchronizationAdapter,
  SupabaseReminderRepository,
} from "@cron-reminder/infrastructure";
import type { AuthenticationPort } from "@cron-reminder/application";

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
          persistSession: true,
        },
      })
    : null;

const redirectTo =
  typeof globalThis.location === "object"
    ? `${globalThis.location.origin}/auth/callback`
    : "cron-reminder://auth/callback";

export const authentication: AuthenticationPort | null = supabase
  ? {
      async currentUser() {
        const { data } = await supabase.auth.getUser();
        return data.user ? { id: data.user.id } : null;
      },
      async signIn(provider) {
        const { error } = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo },
        });
        if (error) throw error;
      },
      async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      },
      async deleteAccount() {
        const { error } = await supabase.functions.invoke("delete-account");
        if (error) throw error;
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
