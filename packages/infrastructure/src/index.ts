import type {
  AuthenticationPort,
  ReminderRepository,
  SyncConflict,
  SynchronizationPort,
} from "@cron-reminder/application";
import {
  detectConflict,
  sameReminder,
  structurallyEqual,
} from "@cron-reminder/application";
import type { Reminder, Schedule } from "@cron-reminder/domain";
import {
  nextOccurrences,
  isValidScheduleTimestamp,
  isValidReminderId,
  validateSchedule,
  validateTimezone,
} from "@cron-reminder/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

type SupabaseClientLike = Pick<SupabaseClient, "auth" | "from" | "functions">;
const REMOTE_PAGE_SIZE = 1_000;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove?(key: string): Promise<void>;
}

export class JsonReminderRepository implements ReminderRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly syncKey: string;

  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "cron-reminder:reminders",
  ) {
    this.syncKey = `${key}:synced-revisions`;
  }

  async list(ownerId: string): Promise<Reminder[]> {
    return (await this.read()).filter(
      (reminder) => reminder.ownerId === ownerId,
    );
  }

  async get(ownerId: string, id: string): Promise<Reminder | null> {
    return (
      (await this.read()).find(
        (reminder) => reminder.ownerId === ownerId && reminder.id === id,
      ) ?? null
    );
  }

  async save(reminder: Reminder): Promise<void> {
    await this.serialize(async () => {
      const reminders = await this.read();
      const index = reminders.findIndex(
        (existing) =>
          existing.ownerId === reminder.ownerId && existing.id === reminder.id,
      );
      if (index < 0) reminders.push(reminder);
      else reminders[index] = reminder;
      await this.write(reminders);
    });
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.serialize(async () => {
      await this.write(
        (await this.read()).filter(
          (reminder) => reminder.ownerId !== ownerId || reminder.id !== id,
        ),
      );
      const revisions = await this.readSyncedRevisions();
      delete revisions[syncRevisionKey(ownerId, id)];
      await this.writeSyncedRevisions(revisions);
    });
  }

  async getSyncedRevision(ownerId: string, id: string): Promise<number | null> {
    await this.queue;
    return (
      (await this.readSyncedRevisions())[syncRevisionKey(ownerId, id)] ?? null
    );
  }

  async setSyncedRevision(
    ownerId: string,
    id: string,
    revision: number,
  ): Promise<void> {
    await this.serialize(async () => {
      const revisions = await this.readSyncedRevisions();
      revisions[syncRevisionKey(ownerId, id)] = revision;
      await this.writeSyncedRevisions(revisions);
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

  private async readSyncedRevisions(): Promise<Record<string, number>> {
    const value = await this.store.get(this.syncKey);
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" &&
          Number.isInteger(entry[1]) &&
          entry[1] >= 0,
      ),
    );
  }

  private async writeSyncedRevisions(
    revisions: Readonly<Record<string, number>>,
  ): Promise<void> {
    if (Object.keys(revisions).length || !this.store.remove) {
      await this.store.set(this.syncKey, JSON.stringify(revisions));
    } else {
      await this.store.remove(this.syncKey);
    }
  }
}

function syncRevisionKey(ownerId: string, id: string): string {
  return `${ownerId}\u0000${id}`;
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
    if (sameReminder(local, incoming)) {
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
    isValidScheduleTimestamp(value.exportedAt) &&
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
    !isValidReminderId(value.id) ||
    typeof value.ownerId !== "string" ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.notes !== "string" ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string") ||
    typeof value.timezone !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.createdAt !== "string" ||
    !isValidScheduleTimestamp(value.createdAt) ||
    typeof value.updatedAt !== "string" ||
    !isValidScheduleTimestamp(value.updatedAt) ||
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
    validateTimezone(value.timezone);
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
    const reminders: Reminder[] = [];
    let lastId: string | null = null;
    for (;;) {
      let query = this.client
        .from("reminders")
        .select("*")
        .eq("owner_id", ownerId)
        .order("id")
        .limit(REMOTE_PAGE_SIZE);
      if (lastId !== null) query = query.gt("id", lastId);
      const { data, error } = await query;
      if (error) throw error;
      const page = (data ?? []).map(fromDatabase);
      reminders.push(...page);
      if (page.length < REMOTE_PAGE_SIZE) return reminders;
      lastId = page[page.length - 1]?.id ?? null;
      if (lastId === null) return reminders;
    }
  }

  async get(ownerId: string, id: string): Promise<Reminder | null> {
    const data = await this.getRow(ownerId, id);
    return data ? fromDatabase(data) : null;
  }

  private async getRow(
    ownerId: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.client
      .from("reminders")
      .select("*")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async save(reminder: Reminder): Promise<void> {
    const existingRow = await this.getRow(reminder.ownerId, reminder.id);
    const existing = existingRow ? fromDatabase(existingRow) : null;
    if (!existing || !existingRow) {
      const { error } = await this.client
        .from("reminders")
        .insert(toDatabase(reminder, calculateInitialDueAt(reminder)));
      if (error) throw error;
      return;
    }
    if (reminder.revision === existing.revision) {
      if (sameReminder(reminder, existing)) return;
      throw new Error(
        `Reminder ${reminder.id} has different content at revision ${reminder.revision}; resolve the conflict before saving.`,
      );
    }
    if (reminder.revision < existing.revision) {
      throw new Error(`Reminder ${reminder.id} is stale; refresh and retry.`);
    }
    const changedScheduling = schedulingChanged(existing, reminder);
    const databaseUpdate = toDatabase(
      reminder,
      changedScheduling
        ? calculateNextDueAt(reminder)
        : typeof existingRow.next_due_at === "string"
          ? existingRow.next_due_at
          : null,
    );
    if (!changedScheduling) delete databaseUpdate.next_due_at;
    delete databaseUpdate.id;
    delete databaseUpdate.owner_id;
    delete databaseUpdate.created_at;
    const { data, error } = await this.client
      .from("reminders")
      .update(databaseUpdate)
      .eq("id", reminder.id)
      .eq("owner_id", reminder.ownerId)
      .eq("revision", existing.revision)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error(
        `Reminder ${reminder.id} was updated concurrently; refresh and retry.`,
      );
    }
  }

  async delete(ownerId: string, id: string): Promise<void> {
    const existing = await this.get(ownerId, id);
    if (existing) {
      const { error: tombstoneError } = await this.client
        .from("reminder_tombstones")
        .upsert({ id, owner_id: existing.ownerId });
      if (tombstoneError) throw tombstoneError;
    }
    const { error } = await this.client
      .from("reminders")
      .delete()
      .eq("id", id)
      .eq("owner_id", ownerId);
    if (error) throw error;
  }

  async listDeletedIds(ownerId: string): Promise<string[]> {
    const ids: string[] = [];
    let lastId: string | null = null;
    for (;;) {
      let query = this.client
        .from("reminder_tombstones")
        .select("id")
        .eq("owner_id", ownerId)
        .order("id")
        .limit(REMOTE_PAGE_SIZE);
      if (lastId !== null) query = query.gt("id", lastId);
      const { data, error } = await query;
      if (error) throw error;
      const page = (data ?? []).map((row) => String(row.id));
      ids.push(...page);
      if (page.length < REMOTE_PAGE_SIZE) return ids;
      lastId = page[page.length - 1] ?? null;
      if (lastId === null) return ids;
    }
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
  syncedRevisions: ReadonlyMap<string, number> = new Map(),
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
    const syncedRevision = syncedRevisions.get(localReminder.id);
    if (detectConflict(localReminder, remoteReminder, syncedRevision)) {
      conflicts.push({
        id: localReminder.id,
        local: localReminder,
        remote: remoteReminder,
      });
    } else if (
      syncedRevision !== undefined &&
      localReminder.revision === syncedRevision &&
      remoteReminder.revision !== syncedRevision
    ) {
      merged[index] = remoteReminder;
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
    const syncedRevisions = new Map<string, number>();
    if (this.local.getSyncedRevision) {
      await Promise.all(
        local.map(async ({ id }) => {
          const revision = await this.local.getSyncedRevision?.(ownerId, id);
          if (revision !== null && revision !== undefined)
            syncedRevisions.set(id, revision);
        }),
      );
    }
    const survivingLocal = local.filter(({ id }) => !deleted.has(id));
    await Promise.all(
      local
        .filter(({ id }) => deleted.has(id))
        .map(({ id }) => this.local.delete(ownerId, id)),
    );
    const { merged, conflicts } = mergeForSynchronization(
      survivingLocal,
      remote,
      syncedRevisions,
    );
    const conflictedIds = new Set(conflicts.map(({ id }) => id));
    const localById = new Map(
      survivingLocal.map((reminder) => [reminder.id, reminder]),
    );
    const remoteById = new Map(
      remote.map((reminder) => [reminder.id, reminder]),
    );
    const latestDeletedIds =
      (await this.remote.listDeletedIds?.(ownerId)) ?? [];
    const latestDeleted = new Set([...deletedIds, ...latestDeletedIds]);
    await Promise.all(
      local
        .filter(({ id }) => latestDeleted.has(id))
        .map(({ id }) => this.local.delete(ownerId, id)),
    );
    await Promise.all(
      merged
        .filter(({ id }) => !conflictedIds.has(id) && !latestDeleted.has(id))
        .map(async (reminder) => {
          const localReminder = localById.get(reminder.id);
          const remoteReminder = remoteById.get(reminder.id);
          if (!remoteReminder) {
            await this.remote.save(reminder);
          } else if (!localReminder) {
            await this.local.save(reminder);
          } else if (!sameReminder(localReminder, remoteReminder)) {
            if (sameReminder(reminder, localReminder))
              await this.remote.save(reminder);
            else await this.local.save(reminder);
          }
          await this.local.setSyncedRevision?.(
            reminder.ownerId,
            reminder.id,
            reminder.revision,
          );
        }),
    );
    return conflicts.filter(({ id }) => !latestDeleted.has(id));
  }

  async resolve(conflict: SyncConflict, resolution: Reminder): Promise<void> {
    const resolved = {
      ...resolution,
      revision: Math.max(conflict.local.revision, conflict.remote.revision) + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.remote.save(resolved);
    await this.local.save(resolved);
    await this.local.setSyncedRevision?.(
      resolved.ownerId,
      resolved.id,
      resolved.revision,
    );
  }
}

function toDatabase(
  reminder: Reminder,
  nextDueAt = calculateInitialDueAt(reminder),
): Record<string, unknown> {
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
    next_due_at: nextDueAt,
  };
}

function schedulingChanged(existing: Reminder, updated: Reminder): boolean {
  return (
    existing.status !== updated.status ||
    existing.timezone !== updated.timezone ||
    !structurallyEqual(existing.schedule, updated.schedule)
  );
}

function calculateInitialDueAt(reminder: Reminder): string | null {
  if (reminder.status !== "active") return null;
  if (reminder.schedule.kind === "once") return reminder.schedule.at;
  try {
    return (
      nextOccurrences(
        reminder.schedule,
        reminder.timezone,
        new Date(Date.parse(reminder.createdAt) - 1),
        1,
      )[0]?.toISOString() ?? null
    );
  } catch {
    return null;
  }
}

function calculateNextDueAt(reminder: Reminder): string | null {
  if (reminder.status !== "active") return null;
  if (reminder.schedule.kind === "once") return reminder.schedule.at;
  try {
    return (
      nextOccurrences(
        reminder.schedule,
        reminder.timezone,
        new Date(Date.parse(reminder.updatedAt) - 1),
        1,
      )[0]?.toISOString() ?? null
    );
  } catch {
    return null;
  }
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
    createdAt: normalizeDatabaseTimestamp(value.created_at),
    updatedAt: normalizeDatabaseTimestamp(value.updated_at),
  };
}

function normalizeDatabaseTimestamp(value: unknown): string {
  const timestamp = String(value);
  if (!isValidScheduleTimestamp(timestamp)) {
    throw new Error(`Invalid database timestamp: ${timestamp}`);
  }
  return new Date(timestamp).toISOString();
}
