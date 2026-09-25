import {
  archiveReminder,
  createReminder,
  duplicateReminder,
  restoreReminder,
  setReminderEnabled,
  updateReminder,
  type CreateReminderInput,
  type HistoryEvent,
  type Occurrence,
  type Reminder,
} from "@cron-reminder/domain";

export interface ReminderRepository {
  list(ownerId: string): Promise<Reminder[]>;
  get(ownerId: string, id: string): Promise<Reminder | null>;
  save(reminder: Reminder): Promise<void>;
  delete(ownerId: string, id: string): Promise<void>;
  listDeletedIds?(ownerId: string): Promise<string[]>;
  getSyncedRevision?(ownerId: string, id: string): Promise<number | null>;
  setSyncedRevision?(
    ownerId: string,
    id: string,
    revision: number,
  ): Promise<void>;
}

export interface HistoryRepository {
  list(ownerId: string, after: Date): Promise<HistoryEvent[]>;
  append(event: HistoryEvent): Promise<void>;
  deleteBefore(cutoff: Date): Promise<number>;
}

export interface Clock {
  now(): Date;
}

export interface TimezoneProvider {
  current(): string;
}

export interface NotificationRegistration {
  id: string;
  ownerId: string;
  platform: "android" | "ios" | "web";
  token: string;
}

export interface NotificationPort {
  requestPermission(): Promise<"granted" | "denied">;
  register(ownerId: string): Promise<NotificationRegistration | null>;
  schedule(reminder: Reminder, occurrence: Occurrence): Promise<void>;
  cancel(occurrenceId: string): Promise<void>;
  showMissedSummary(count: number): Promise<void>;
}

export interface AuthenticationPort {
  currentUser(): Promise<{ id: string } | null>;
  signIn(provider: "google" | "apple" | "azure" | "github"): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
}

export interface SyncConflict {
  id: string;
  local: Reminder;
  remote: Reminder;
}

export interface SynchronizationPort {
  synchronize(ownerId: string): Promise<readonly SyncConflict[]>;
  resolve(conflict: SyncConflict, resolution: Reminder): Promise<void>;
}

export type CreateReminderCommand = Omit<CreateReminderInput, "id" | "now">;

export class ReminderService {
  constructor(
    private readonly repository: ReminderRepository,
    private readonly clock: Clock,
    private readonly createId: () => string,
  ) {}

  async create(command: CreateReminderCommand): Promise<Reminder> {
    const reminder = createReminder({
      ...command,
      id: this.createId(),
      now: this.clock.now().toISOString(),
    });
    await this.repository.save(reminder);
    return reminder;
  }

  async update(
    ownerId: string,
    id: string,
    changes: Parameters<typeof updateReminder>[1],
  ): Promise<Reminder> {
    const reminder = await this.require(ownerId, id);
    const updated = updateReminder(
      reminder,
      changes,
      this.clock.now().toISOString(),
    );
    await this.repository.save(updated);
    return updated;
  }

  async duplicate(ownerId: string, id: string): Promise<Reminder> {
    const copy = duplicateReminder(
      await this.require(ownerId, id),
      this.createId(),
      this.clock.now().toISOString(),
    );
    await this.repository.save(copy);
    return copy;
  }

  async setEnabled(
    ownerId: string,
    id: string,
    enabled: boolean,
  ): Promise<Reminder> {
    return this.save(
      setReminderEnabled(
        await this.require(ownerId, id),
        enabled,
        this.clock.now().toISOString(),
      ),
    );
  }

  async archive(ownerId: string, id: string): Promise<Reminder> {
    return this.save(
      archiveReminder(
        await this.require(ownerId, id),
        this.clock.now().toISOString(),
      ),
    );
  }

  async restore(ownerId: string, id: string): Promise<Reminder> {
    return this.save(
      restoreReminder(
        await this.require(ownerId, id),
        this.clock.now().toISOString(),
      ),
    );
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.require(ownerId, id);
    await this.repository.delete(ownerId, id);
  }

  private async save(reminder: Reminder): Promise<Reminder> {
    await this.repository.save(reminder);
    return reminder;
  }

  private async require(ownerId: string, id: string): Promise<Reminder> {
    const reminder = await this.repository.get(ownerId, id);
    if (!reminder) throw new Error("Reminder not found.");
    return reminder;
  }
}

export interface ReminderQuery {
  query?: string;
  tags?: readonly string[];
  status?: Reminder["status"] | "all";
  sort?: "title" | "status" | "updated";
}

export function filterReminders(
  reminders: readonly Reminder[],
  query: ReminderQuery,
): Reminder[] {
  const needle = query.query?.trim().toLocaleLowerCase();
  const tags = query.tags ?? [];
  const result = reminders.filter((reminder) => {
    const searchable =
      `${reminder.title} ${reminder.notes} ${reminder.tags.join(" ")}`.toLocaleLowerCase();
    return (
      (!needle || searchable.includes(needle)) &&
      (!query.status ||
        query.status === "all" ||
        reminder.status === query.status) &&
      tags.every((tag) => reminder.tags.includes(tag))
    );
  });
  const sort = query.sort ?? "updated";
  return result.sort((left, right) => {
    if (sort === "title") return left.title.localeCompare(right.title);
    if (sort === "status") return left.status.localeCompare(right.status);
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function detectConflict(
  local: Reminder,
  remote: Reminder,
  syncedRevision?: number,
): boolean {
  if (local.id !== remote.id || sameReminder(local, remote)) return false;
  if (syncedRevision === undefined) return true;
  const localChanged = local.revision !== syncedRevision;
  const remoteChanged = remote.revision !== syncedRevision;
  return (localChanged && remoteChanged) || (!localChanged && !remoteChanged);
}

export function sameReminder(left: Reminder, right: Reminder): boolean {
  return structurallyEqual(left, right);
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}
