import type {
  TaskRepository,
  TaskSyncConflict,
  TaskSynchronizationPort,
} from "@cron-reminder/application";
import {
  detectTaskConflict,
  sameTask,
  structurallyEqual,
} from "@cron-reminder/application";
import {
  calculateTaskReminderOccurrences,
  isValidReminderId,
  isValidScheduleTimestamp,
  validateTaskReminderPolicy,
  validateTimezone,
  type Schedule,
  type Task,
  type TaskReminderPolicy,
} from "@cron-reminder/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KeyValueStore } from "./index";

type SupabaseClientLike = Pick<SupabaseClient, "from">;
const REMOTE_PAGE_SIZE = 1_000;

export class JsonTaskRepository implements TaskRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly syncKey: string;
  private readonly deletedKey: string;

  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "cron-reminder:tasks",
  ) {
    this.syncKey = `${key}:synced-revisions`;
    this.deletedKey = `${key}:deleted`;
  }

  async list(ownerId: string): Promise<Task[]> {
    return (await this.read()).filter((task) => task.ownerId === ownerId);
  }

  async get(ownerId: string, id: string): Promise<Task | null> {
    return (
      (await this.read()).find(
        (task) => task.ownerId === ownerId && task.id === id,
      ) ?? null
    );
  }

  async save(task: Task): Promise<void> {
    await this.serialize(async () => {
      const tasks = await this.read();
      const index = tasks.findIndex(
        (existing) =>
          existing.ownerId === task.ownerId && existing.id === task.id,
      );
      if (index < 0) tasks.push(task);
      else tasks[index] = task;
      await this.write(tasks);
      const deleted = await this.readDeleted();
      delete deleted[storageIdentity(task.ownerId, task.id)];
      await this.writeRecord(this.deletedKey, deleted);
    });
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.serialize(async () => {
      const tasks = await this.read();
      const exists = tasks.some(
        (task) => task.ownerId === ownerId && task.id === id,
      );
      await this.write(
        tasks.filter((task) => task.ownerId !== ownerId || task.id !== id),
      );
      if (exists) {
        const deleted = await this.readDeleted();
        deleted[storageIdentity(ownerId, id)] = { ownerId, id };
        await this.writeRecord(this.deletedKey, deleted);
      }
      const revisions = await this.readSyncedRevisions();
      delete revisions[storageIdentity(ownerId, id)];
      await this.writeRecord(this.syncKey, revisions);
    });
  }

  async listDeletedIds(ownerId: string): Promise<string[]> {
    await this.queue;
    return Object.values(await this.readDeleted())
      .filter((item) => item.ownerId === ownerId)
      .map(({ id }) => id);
  }

  async getSyncedRevision(ownerId: string, id: string): Promise<number | null> {
    await this.queue;
    return (
      (await this.readSyncedRevisions())[storageIdentity(ownerId, id)] ?? null
    );
  }

  async setSyncedRevision(
    ownerId: string,
    id: string,
    revision: number,
  ): Promise<void> {
    await this.serialize(async () => {
      const revisions = await this.readSyncedRevisions();
      revisions[storageIdentity(ownerId, id)] = revision;
      await this.writeRecord(this.syncKey, revisions);
    });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<Task[]> {
    const value = await this.store.get(this.key);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Task[]) : [];
  }

  private async write(tasks: readonly Task[]): Promise<void> {
    await this.store.set(this.key, JSON.stringify(tasks));
  }

  private async readDeleted(): Promise<
    Record<string, { ownerId: string; id: string }>
  > {
    const value = await this.store.get(this.deletedKey);
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, { ownerId: string; id: string }] =>
          isRecord(entry[1]) &&
          typeof entry[1].ownerId === "string" &&
          typeof entry[1].id === "string",
      ),
    );
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

  private async writeRecord(
    key: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (Object.keys(value).length || !this.store.remove)
      await this.store.set(key, JSON.stringify(value));
    else await this.store.remove(key);
  }
}

export class SupabaseTaskRepository implements TaskRepository {
  constructor(private readonly client: SupabaseClientLike) {}

  async list(ownerId: string): Promise<Task[]> {
    const tasks: Task[] = [];
    let lastId: string | null = null;
    for (;;) {
      let query = this.client
        .from("tasks")
        .select("*")
        .eq("owner_id", ownerId)
        .order("id")
        .limit(REMOTE_PAGE_SIZE);
      if (lastId !== null) query = query.gt("id", lastId);
      const { data, error } = await query;
      if (error) throw error;
      const page = (data ?? []).map(taskFromDatabase);
      tasks.push(...page);
      if (page.length < REMOTE_PAGE_SIZE) return tasks;
      lastId = page[page.length - 1]?.id ?? null;
      if (lastId === null) return tasks;
    }
  }

  async get(ownerId: string, id: string): Promise<Task | null> {
    const row = await this.getRow(ownerId, id);
    return row ? taskFromDatabase(row) : null;
  }

  async save(task: Task): Promise<void> {
    const existingRow = await this.getRow(task.ownerId, task.id);
    const existing = existingRow ? taskFromDatabase(existingRow) : null;
    if (!existing || !existingRow) {
      const { error } = await this.client
        .from("tasks")
        .insert(taskToDatabase(task));
      if (error) throw error;
      return;
    }
    if (task.revision === existing.revision) {
      if (sameTask(task, existing)) return;
      throw new Error(
        `Task ${task.id} has different content at revision ${task.revision}; resolve the conflict before saving.`,
      );
    }
    if (task.revision < existing.revision)
      throw new Error(`Task ${task.id} is stale; refresh and retry.`);

    const changedScheduling = taskSchedulingChanged(existing, task);
    const update = taskToDatabase(
      task,
      changedScheduling
        ? calculateTaskNextDueAt(task)
        : typeof existingRow.next_due_at === "string"
          ? existingRow.next_due_at
          : null,
    );
    if (!changedScheduling) delete update.next_due_at;
    delete update.id;
    delete update.owner_id;
    delete update.created_at;
    const { data, error } = await this.client
      .from("tasks")
      .update(update)
      .eq("id", task.id)
      .eq("owner_id", task.ownerId)
      .eq("revision", existing.revision)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0)
      throw new Error(
        `Task ${task.id} was updated concurrently; refresh and retry.`,
      );
  }

  async delete(ownerId: string, id: string): Promise<void> {
    const { error: tombstoneError } = await this.client
      .from("task_tombstones")
      .upsert({ id, owner_id: ownerId });
    if (tombstoneError) throw tombstoneError;
    const { error } = await this.client
      .from("tasks")
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
        .from("task_tombstones")
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

  private async getRow(
    ownerId: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.client
      .from("tasks")
      .select("*")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
}

export function mergeTasksForSynchronization(
  local: readonly Task[],
  remote: readonly Task[],
  syncedRevisions: ReadonlyMap<string, number> = new Map(),
): { merged: Task[]; conflicts: TaskSyncConflict[] } {
  const merged = [...local];
  const conflicts: TaskSyncConflict[] = [];
  for (const remoteTask of remote) {
    const index = merged.findIndex(({ id }) => id === remoteTask.id);
    if (index < 0) {
      merged.push(remoteTask);
      continue;
    }
    const localTask = merged[index];
    if (!localTask) continue;
    const syncedRevision = syncedRevisions.get(localTask.id);
    if (detectTaskConflict(localTask, remoteTask, syncedRevision)) {
      conflicts.push({
        id: localTask.id,
        local: localTask,
        remote: remoteTask,
      });
    } else if (
      syncedRevision !== undefined &&
      localTask.revision === syncedRevision &&
      remoteTask.revision !== syncedRevision
    ) {
      merged[index] = remoteTask;
    } else if (remoteTask.revision > localTask.revision) {
      merged[index] = remoteTask;
    }
  }
  return { merged, conflicts };
}

export class OfflineTaskSynchronizationAdapter implements TaskSynchronizationPort {
  constructor(
    private readonly local: TaskRepository,
    private readonly remote: TaskRepository,
  ) {}

  async synchronize(ownerId: string): Promise<readonly TaskSyncConflict[]> {
    const [local, remote, localDeletedIds, remoteDeletedIds] =
      await Promise.all([
        this.local.list(ownerId),
        this.remote.list(ownerId),
        this.local.listDeletedIds?.(ownerId) ?? Promise.resolve([]),
        this.remote.listDeletedIds?.(ownerId) ?? Promise.resolve([]),
      ]);

    await Promise.all(
      localDeletedIds.map((id) => this.remote.delete(ownerId, id)),
    );
    const latestRemoteDeleted =
      (await this.remote.listDeletedIds?.(ownerId)) ?? [];
    const deleted = new Set([
      ...localDeletedIds,
      ...remoteDeletedIds,
      ...latestRemoteDeleted,
    ]);
    await Promise.all(
      local
        .filter(({ id }) => deleted.has(id))
        .map(({ id }) => this.local.delete(ownerId, id)),
    );

    const survivingLocal = local.filter(({ id }) => !deleted.has(id));
    const survivingRemote = remote.filter(({ id }) => !deleted.has(id));
    const syncedRevisions = new Map<string, number>();
    if (this.local.getSyncedRevision) {
      await Promise.all(
        survivingLocal.map(async ({ id }) => {
          const revision = await this.local.getSyncedRevision?.(ownerId, id);
          if (revision !== null && revision !== undefined)
            syncedRevisions.set(id, revision);
        }),
      );
    }
    const { merged, conflicts } = mergeTasksForSynchronization(
      survivingLocal,
      survivingRemote,
      syncedRevisions,
    );
    const conflicted = new Set(conflicts.map(({ id }) => id));
    const localById = new Map(survivingLocal.map((task) => [task.id, task]));
    const remoteById = new Map(survivingRemote.map((task) => [task.id, task]));
    const newestDeleted = new Set([
      ...deleted,
      ...((await this.remote.listDeletedIds?.(ownerId)) ?? []),
    ]);
    await Promise.all(
      survivingLocal
        .filter(({ id }) => newestDeleted.has(id))
        .map(({ id }) => this.local.delete(ownerId, id)),
    );
    await Promise.all(
      merged
        .filter(({ id }) => !conflicted.has(id) && !newestDeleted.has(id))
        .map(async (task) => {
          const localTask = localById.get(task.id);
          const remoteTask = remoteById.get(task.id);
          if (!remoteTask) await this.remote.save(task);
          else if (!localTask) await this.local.save(task);
          else if (!sameTask(localTask, remoteTask)) {
            if (sameTask(task, localTask)) await this.remote.save(task);
            else await this.local.save(task);
          }
          await this.local.setSyncedRevision?.(
            task.ownerId,
            task.id,
            task.revision,
          );
        }),
    );
    return conflicts.filter(({ id }) => !newestDeleted.has(id));
  }

  async resolve(conflict: TaskSyncConflict, resolution: Task): Promise<void> {
    const resolved: Task = {
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

export function isTaskData(value: unknown): value is Task {
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
    (value.categoryId != null &&
      (typeof value.categoryId !== "string" ||
        !isValidReminderId(value.categoryId))) ||
    typeof value.dueAt !== "string" ||
    !isValidScheduleTimestamp(value.dueAt) ||
    !isTaskReminderPolicy(value.reminderPolicy) ||
    typeof value.timezone !== "string" ||
    (value.status !== "open" &&
      value.status !== "completed" &&
      value.status !== "archived") ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.createdAt !== "string" ||
    !isValidScheduleTimestamp(value.createdAt) ||
    typeof value.updatedAt !== "string" ||
    !isValidScheduleTimestamp(value.updatedAt)
  )
    return false;
  try {
    validateTimezone(value.timezone);
    validateTaskReminderPolicy(
      value.reminderPolicy,
      value.timezone,
      value.dueAt,
      value.createdAt,
    );
  } catch {
    return false;
  }
  return true;
}

function isTaskReminderPolicy(value: unknown): value is TaskReminderPolicy {
  return (
    isRecord(value) &&
    isSchedule(value.primary) &&
    (value.overdue === undefined ||
      (isSchedule(value.overdue) && value.overdue.kind !== "once"))
  );
}

function isSchedule(value: unknown): value is Schedule {
  if (!isRecord(value)) return false;
  if (value.kind === "once") return typeof value.at === "string";
  if (value.kind === "daily-times") {
    if (
      !Array.isArray(value.times) ||
      !value.times.every((time) => typeof time === "string")
    )
      return false;
  } else if (value.kind !== "cron" || typeof value.expression !== "string")
    return false;
  return (
    (value.startAt === undefined || typeof value.startAt === "string") &&
    (value.endAt === undefined || typeof value.endAt === "string") &&
    (value.occurrenceLimit === undefined ||
      typeof value.occurrenceLimit === "number")
  );
}

function taskToDatabase(
  task: Task,
  nextDueAt = calculateTaskNextDueAt(task),
): Record<string, unknown> {
  return {
    id: task.id,
    owner_id: task.ownerId,
    title: task.title,
    notes: task.notes,
    tags: task.tags,
    category_id: task.categoryId ?? null,
    due_at: task.dueAt,
    reminder_policy: task.reminderPolicy,
    timezone: task.timezone,
    status: task.status,
    revision: task.revision,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    next_due_at: nextDueAt,
  };
}

function taskFromDatabase(value: Record<string, unknown>): Task {
  return {
    id: String(value.id),
    ownerId: String(value.owner_id),
    title: String(value.title),
    notes: String(value.notes ?? ""),
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    categoryId:
      typeof value.category_id === "string" ? value.category_id : null,
    dueAt: normalizeDatabaseTimestamp(value.due_at),
    reminderPolicy: value.reminder_policy as TaskReminderPolicy,
    timezone: String(value.timezone),
    status: value.status as Task["status"],
    revision: Number(value.revision),
    createdAt: normalizeDatabaseTimestamp(value.created_at),
    updatedAt: normalizeDatabaseTimestamp(value.updated_at),
  };
}

function calculateTaskNextDueAt(task: Task): string | null {
  try {
    return (
      calculateTaskReminderOccurrences(
        task,
        new Date(Date.parse(task.updatedAt) - 1),
        1,
      )[0]?.scheduledAt ?? null
    );
  } catch {
    return null;
  }
}

function taskSchedulingChanged(existing: Task, updated: Task): boolean {
  return (
    existing.status !== updated.status ||
    existing.timezone !== updated.timezone ||
    existing.dueAt !== updated.dueAt ||
    !structurallyEqual(existing.reminderPolicy, updated.reminderPolicy)
  );
}

function storageIdentity(ownerId: string, id: string): string {
  return `${ownerId}\u0000${id}`;
}

function normalizeDatabaseTimestamp(value: unknown): string {
  const text = String(value);
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
