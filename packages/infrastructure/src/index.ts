import type {
  AuthenticationPort,
  ReminderRepository,
  SyncConflict,
  SynchronizationPort,
} from "@cron-reminder/application";
import { detectConflict } from "@cron-reminder/application";
import type { Reminder, Schedule } from "@cron-reminder/domain";
import { validateSchedule } from "@cron-reminder/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

type SupabaseClientLike = Pick<SupabaseClient, "auth" | "from" | "functions">;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove?(key: string): Promise<void>;
}

export class JsonReminderRepository implements ReminderRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "cron-reminder:reminders",
  ) {}

  async list(ownerId: string): Promise<Reminder[]> {
    return (await this.read()).filter(
      (reminder) => reminder.ownerId === ownerId,
    );
  }

  async get(id: string): Promise<Reminder | null> {
    return (await this.read()).find((reminder) => reminder.id === id) ?? null;
  }

  async save(reminder: Reminder): Promise<void> {
    await this.serialize(async () => {
      const reminders = await this.read();
      const index = reminders.findIndex(({ id }) => id === reminder.id);
      if (index < 0) reminders.push(reminder);
      else reminders[index] = reminder;
      await this.write(reminders);
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(async () => {
      await this.write(
        (await this.read()).filter((reminder) => reminder.id !== id),
      );
    });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<Reminder[]> {
    const value = await this.store.get(this.key);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Reminder[]) : [];
  }

  private async write(reminders: readonly Reminder[]): Promise<void> {
    await this.store.set(this.key, JSON.stringify(reminders));
  }
}

export class BrowserKeyValueStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    globalThis.localStorage?.setItem(key, value);
  }
  async remove(key: string): Promise<void> {
    globalThis.localStorage?.removeItem(key);
  }
}

export interface Backup {
  version: 1;
  exportedAt: string;
  reminders: Reminder[];
}

export interface ImportResult {
  merged: Reminder[];
  imported: number;
  skipped: number;
  invalid: number;
  conflicts: readonly SyncConflict[];
}

export function exportBackup(
  reminders: readonly Reminder[],
  now: Date,
): string {
  const backup: Backup = {
    version: 1,
    exportedAt: now.toISOString(),
    reminders: reminders.map((reminder) => structuredClone(reminder)),
  };
  return JSON.stringify(backup, null, 2);
}

export function importBackup(
  input: string,
  existing: readonly Reminder[],
  ownerId: string,
): ImportResult {
  const parsed: unknown = JSON.parse(input);
  if (!isBackup(parsed))
    throw new Error("Invalid or unsupported reminder backup.");
  const merged = [...existing];
  const conflicts: SyncConflict[] = [];
  let imported = 0;
  let skipped = 0;
  let invalid = 0;
  for (const value of parsed.reminders) {
    if (!isReminder(value)) {
      invalid++;
      continue;
    }
    const incoming = { ...value, ownerId };
    const index = merged.findIndex(({ id }) => id === incoming.id);
    if (index < 0) {
      merged.push(incoming);
      imported++;
      continue;
    }
    const local = merged[index];
    if (!local) continue;
    if (JSON.stringify(local) === JSON.stringify(incoming)) {
      skipped++;
    } else {
      conflicts.push({ id: incoming.id, local, remote: incoming });
    }
  }
  return { merged, imported, skipped, invalid, conflicts };
}

function isBackup(value: unknown): value is Backup {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.exportedAt === "string" &&
    Array.isArray(value.reminders)
  );
}

function isReminderSound(value: unknown): value is Reminder["sound"] {
  if (!isRecord(value)) return false;
  return (
    value.mode === "default" ||
    value.mode === "silent" ||
    value.mode === "vibrate"
  );
}

function isSchedule(value: unknown): value is Schedule {
  if (!isRecord(value)) return false;
  if (value.kind === "once") return typeof value.at === "string";
  if (value.kind !== "cron") return false;
  if (typeof value.expression !== "string") return false;
  if (value.startAt !== undefined && typeof value.startAt !== "string")
    return false;
  if (value.endAt !== undefined && typeof value.endAt !== "string")
    return false;
  if (
    value.occurrenceLimit !== undefined &&
    typeof value.occurrenceLimit !== "number"
  )
    return false;
  return true;
}

function isReminder(value: unknown): value is Reminder {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.notes !== "string" ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string") ||
    typeof value.timezone !== "string" ||
    typeof value.revision !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.status !== "active" &&
      value.status !== "disabled" &&
      value.status !== "archived") ||
    !isReminderSound(value.sound) ||
    !isSchedule(value.schedule)
  ) {
    return false;
  }
  try {
    validateSchedule(value.schedule);
  } catch {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class SupabaseReminderRepository implements ReminderRepository {
  constructor(private readonly client: SupabaseClientLike) {}

  async list(ownerId: string): Promise<Reminder[]> {
    const { data, error } = await this.client
      .from("reminders")
      .select("*")
      .eq("owner_id", ownerId);
    if (error) throw error;
    return (data ?? []).map(fromDatabase);
  }

  async get(id: string): Promise<Reminder | null> {
    const { data, error } = await this.client
      .from("reminders")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? fromDatabase(data) : null;
  }

  async save(reminder: Reminder): Promise<void> {
    const existing = await this.get(reminder.id);
    if (!existing) {
      const { error } = await this.client
        .from("reminders")
        .insert(toDatabase(reminder));
      if (error) throw error;
      return;
    }
    if (reminder.revision <= existing.revision) return;
    const { data, error } = await this.client
      .from("reminders")
      .update(toDatabase(reminder))
      .eq("id", reminder.id)
      .eq("revision", existing.revision)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error(
        `Reminder ${reminder.id} was updated concurrently; refresh and retry.`,
      );
    }
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    const { error } = await this.client.from("reminders").delete().eq("id", id);
    if (error) throw error;
    if (existing) {
      const { error: tombstoneError } = await this.client
        .from("reminder_tombstones")
        .upsert({ id, owner_id: existing.ownerId });
      if (tombstoneError) throw tombstoneError;
    }
  }

  async listDeletedIds(ownerId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("reminder_tombstones")
      .select("id")
      .eq("owner_id", ownerId);
    if (error) throw error;
    return (data ?? []).map((row) => String(row.id));
  }
}

export class SupabaseAuthenticationAdapter implements AuthenticationPort {
  constructor(
    private readonly client: SupabaseClientLike,
    private readonly redirectTo: string,
  ) {}

  async currentUser(): Promise<{ id: string } | null> {
    const { data, error } = await this.client.auth.getUser();
    if (error) return null;
    return data.user ? { id: data.user.id } : null;
  }

  async signIn(
    provider: "google" | "apple" | "azure" | "github",
  ): Promise<void> {
    const { error } = await this.client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: this.redirectTo },
    });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }

  async deleteAccount(): Promise<void> {
    const { error } = await this.client.functions.invoke("delete-account");
    if (error) throw error;
    await this.signOut();
  }
}

export function mergeForSynchronization(
  local: readonly Reminder[],
  remote: readonly Reminder[],
): { merged: Reminder[]; conflicts: SyncConflict[] } {
  const merged = [...local];
  const conflicts: SyncConflict[] = [];
  for (const remoteReminder of remote) {
    const index = merged.findIndex(({ id }) => id === remoteReminder.id);
    if (index < 0) {
      merged.push(remoteReminder);
      continue;
    }

    const localReminder = merged[index];
    if (!localReminder) continue;
    if (detectConflict(localReminder, remoteReminder)) {
      conflicts.push({
        id: localReminder.id,
        local: localReminder,
        remote: remoteReminder,
      });
    } else if (remoteReminder.revision > localReminder.revision) {
      merged[index] = remoteReminder;
    }
  }
  return { merged, conflicts };
}

export class OfflineSynchronizationAdapter implements SynchronizationPort {
  constructor(
    private readonly local: ReminderRepository,
    private readonly remote: ReminderRepository,
  ) {}

  async synchronize(ownerId: string): Promise<readonly SyncConflict[]> {
    const [local, remote, deletedIds] = await Promise.all([
      this.local.list(ownerId),
      this.remote.list(ownerId),
      this.remote.listDeletedIds?.(ownerId) ?? Promise.resolve([]),
    ]);
    const deleted = new Set(deletedIds);
    const survivingLocal = local.filter(({ id }) => !deleted.has(id));
    await Promise.all(
      local
        .filter(({ id }) => deleted.has(id))
        .map(({ id }) => this.local.delete(id)),
    );
    const { merged, conflicts } = mergeForSynchronization(
      survivingLocal,
      remote,
    );
    const conflictedIds = new Set(conflicts.map(({ id }) => id));
    await Promise.all(
      merged
        .filter(({ id }) => !conflictedIds.has(id) && !deleted.has(id))
        .flatMap((reminder) => [
          this.local.save(reminder),
          this.remote.save(reminder),
        ]),
    );
    return conflicts;
  }

  async resolve(_conflict: SyncConflict, resolution: Reminder): Promise<void> {
    const resolved = {
      ...resolution,
      revision: resolution.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([this.local.save(resolved), this.remote.save(resolved)]);
  }
}

function toDatabase(reminder: Reminder): Record<string, unknown> {
  return {
    id: reminder.id,
    owner_id: reminder.ownerId,
    title: reminder.title,
    notes: reminder.notes,
    tags: reminder.tags,
    schedule: reminder.schedule,
    timezone: reminder.timezone,
    sound: reminder.sound,
    status: reminder.status,
    revision: reminder.revision,
    created_at: reminder.createdAt,
    updated_at: reminder.updatedAt,
  };
}

function fromDatabase(value: Record<string, unknown>): Reminder {
  return {
    id: String(value.id),
    ownerId: String(value.owner_id),
    title: String(value.title),
    notes: String(value.notes ?? ""),
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    schedule: value.schedule as Reminder["schedule"],
    timezone: String(value.timezone),
    sound: value.sound as Reminder["sound"],
    status: value.status as Reminder["status"],
    revision: Number(value.revision),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}
