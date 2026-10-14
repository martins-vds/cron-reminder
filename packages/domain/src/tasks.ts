import type { OccurrenceStatus, Schedule } from "./index.ts";
import {
  isValidReminderId,
  isValidScheduleTimestamp,
  nextOccurrences,
  resolvePostponement,
  validateSchedule,
  validateTimezone,
} from "./index.ts";

export type TaskStatus = "open" | "completed" | "archived";
export type RecurringSchedule = Exclude<Schedule, { kind: "once" }>;

export type TaskReminderPolicy =
  | {
      primary: Extract<Schedule, { kind: "once" }>;
      overdue: RecurringSchedule;
    }
  | {
      primary: RecurringSchedule;
      overdue?: never;
    };

export interface Task {
  id: string;
  ownerId: string;
  title: string;
  notes: string;
  tags: readonly string[];
  categoryId?: string | null;
  dueAt: string;
  reminderPolicy: TaskReminderPolicy;
  timezone: string;
  status: TaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReminderOccurrence {
  scheduledAt: string;
  source: "primary" | "overdue";
}

export interface TaskOccurrence extends TaskReminderOccurrence {
  id: string;
  taskId: string;
  status: OccurrenceStatus;
  actedAt?: string;
  snoozedUntil?: string;
}

export interface CreateTaskInput {
  id: string;
  ownerId: string;
  title: string;
  notes?: string;
  tags?: readonly string[];
  categoryId?: string | null;
  dueAt: string;
  reminderPolicy: TaskReminderPolicy;
  timezone: string;
  now: string;
}

export type UpdateTaskChanges = Partial<
  Pick<
    Task,
    | "title"
    | "notes"
    | "tags"
    | "categoryId"
    | "dueAt"
    | "reminderPolicy"
    | "timezone"
  >
>;

export function validateTaskReminderPolicy(
  policy: TaskReminderPolicy,
  timezone: string,
  dueAt: string,
  from: string,
): void {
  if (!isValidScheduleTimestamp(dueAt))
    throw new Error("Task due date must be a valid date.");
  if (!isValidScheduleTimestamp(from))
    throw new Error("Task calculation date must be a valid date.");
  validateSchedule(policy.primary);
  if (policy.primary.kind === "once") {
    if (!policy.overdue)
      throw new Error(
        "A one-time task reminder requires a recurring overdue schedule.",
      );
    if ((policy.overdue as Schedule).kind === "once")
      throw new Error("The overdue task schedule must be recurring.");
    validateSchedule(policy.overdue);
  } else if (policy.overdue !== undefined) {
    throw new Error(
      "An overdue schedule is only supported for a one-time primary reminder.",
    );
  }

  const first =
    policy.primary.kind === "once"
      ? new Date(policy.primary.at)
      : nextOccurrences(
          policy.primary,
          timezone,
          new Date(Date.parse(from) - 1),
          1,
        )[0];
  if (!first)
    throw new Error("Task reminder policy must calculate a first reminder.");
  if (first.getTime() > Date.parse(dueAt))
    throw new Error(
      "The first task reminder must be on or before its due date.",
    );
}

export function createTask(input: CreateTaskInput): Task {
  if (!isValidReminderId(input.id))
    throw new Error("Task ID contains unsupported characters.");
  const title = input.title.trim();
  if (!title) throw new Error("Task title is required.");
  if (input.categoryId != null && !isValidReminderId(input.categoryId))
    throw new Error("Category ID contains unsupported characters.");
  validateTimezone(input.timezone);
  validateTaskReminderPolicy(
    input.reminderPolicy,
    input.timezone,
    input.dueAt,
    input.now,
  );
  return {
    id: input.id,
    ownerId: input.ownerId,
    title,
    notes: input.notes?.trim() ?? "",
    tags: normalizeTags(input.tags ?? []),
    categoryId: input.categoryId ?? null,
    dueAt: input.dueAt,
    reminderPolicy: input.reminderPolicy,
    timezone: input.timezone,
    status: "open",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function updateTask(
  task: Task,
  changes: UpdateTaskChanges,
  now: string,
): Task {
  const updated: Task = {
    ...task,
    ...changes,
    title: (changes.title ?? task.title).trim(),
    notes: (changes.notes ?? task.notes).trim(),
    tags: normalizeTags(changes.tags ?? task.tags),
    revision: task.revision + 1,
    updatedAt: now,
  };
  if (!updated.title) throw new Error("Task title is required.");
  if (updated.categoryId != null && !isValidReminderId(updated.categoryId))
    throw new Error("Category ID contains unsupported characters.");
  validateTimezone(updated.timezone);
  validateTaskReminderPolicy(
    updated.reminderPolicy,
    updated.timezone,
    updated.dueAt,
    task.createdAt,
  );
  return updated;
}

export function completeTask(task: Task, now?: string): Task {
  if (task.status === "archived")
    throw new Error("Restore an archived task first.");
  return task.status === "completed"
    ? task
    : transitionTask(task, "completed", now);
}

export function archiveTask(task: Task, now?: string): Task {
  return task.status === "archived"
    ? task
    : transitionTask(task, "archived", now);
}

export function restoreTask(task: Task, now?: string): Task {
  return task.status === "open" ? task : transitionTask(task, "open", now);
}

export function calculateTaskReminderOccurrences(
  task: Pick<Task, "status" | "reminderPolicy" | "timezone" | "dueAt">,
  after: Date,
  count = 5,
): TaskReminderOccurrence[] {
  if (task.status !== "open" || count < 1) return [];
  const { primary, overdue } = task.reminderPolicy;
  if (primary.kind !== "once") {
    return nextOccurrences(primary, task.timezone, after, count).map(
      (scheduledAt) => ({
        scheduledAt: scheduledAt.toISOString(),
        source: "primary",
      }),
    );
  }

  const results: TaskReminderOccurrence[] = [];
  const primaryAt = new Date(primary.at);
  if (primaryAt > after && primaryAt.getTime() <= Date.parse(task.dueAt)) {
    results.push({
      scheduledAt: primaryAt.toISOString(),
      source: "primary",
    });
  }
  if (results.length === count || !overdue) return results;
  const overdueAfter = new Date(
    Math.max(after.getTime(), Date.parse(task.dueAt)),
  );
  results.push(
    ...nextOccurrences(
      overdue,
      task.timezone,
      overdueAfter,
      count - results.length,
    ).map((scheduledAt) => ({
      scheduledAt: scheduledAt.toISOString(),
      source: "overdue" as const,
    })),
  );
  return results;
}

export function nextTaskOccurrences(
  task: Pick<Task, "status" | "reminderPolicy" | "timezone" | "dueAt">,
  after: Date,
  count = 5,
): Date[] {
  return calculateTaskReminderOccurrences(task, after, count).map(
    ({ scheduledAt }) => new Date(scheduledAt),
  );
}

export function createTaskOccurrence(
  taskId: string,
  reminder: TaskReminderOccurrence,
): TaskOccurrence {
  return {
    id: `${taskId}:${reminder.scheduledAt}`,
    taskId,
    ...reminder,
    status: "scheduled",
  };
}

export function dismissTaskOccurrence(
  occurrence: TaskOccurrence,
  now: string,
): TaskOccurrence {
  return { ...occurrence, status: "dismissed", actedAt: now };
}

export function completeTaskOccurrence(
  occurrence: TaskOccurrence,
  now: string,
): TaskOccurrence {
  return {
    ...occurrence,
    status: "completed",
    actedAt: now,
    snoozedUntil: undefined,
  };
}

export function postponeTaskOccurrence(
  occurrence: TaskOccurrence,
  selection: number | "next" | { until: string },
  now: string,
  nextOccurrenceAt: string | null = null,
): TaskOccurrence {
  const postponement = resolvePostponement(selection, now, nextOccurrenceAt);
  return {
    ...occurrence,
    status: "postponed",
    actedAt: now,
    snoozedUntil: postponement.until,
  };
}

function transitionTask(task: Task, status: TaskStatus, now?: string): Task {
  return {
    ...task,
    status,
    revision: task.revision + 1,
    updatedAt: now ?? task.updatedAt,
  };
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
