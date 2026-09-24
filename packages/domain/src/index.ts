import { CronExpressionParser } from "cron-parser";

export type ReminderStatus = "active" | "disabled" | "archived";
export type OccurrenceStatus =
  | "scheduled"
  | "triggered"
  | "delivering"
  | "dismissed"
  | "postponed"
  | "missed"
  | "delivery-failed";
export type HistoryEventType =
  "triggered" | "dismissed" | "postponed" | "missed" | "delivery-failed";

export type ReminderSound = { mode: "default" | "silent" | "vibrate" };

export type Schedule =
  | { kind: "once"; at: string }
  | {
      kind: "cron";
      expression: string;
      startAt?: string;
      endAt?: string;
      occurrenceLimit?: number;
    };

export interface Reminder {
  id: string;
  ownerId: string;
  title: string;
  notes: string;
  tags: readonly string[];
  schedule: Schedule;
  timezone: string;
  sound: ReminderSound;
  status: ReminderStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Occurrence {
  id: string;
  reminderId: string;
  scheduledAt: string;
  status: OccurrenceStatus;
  actedAt?: string;
  snoozedUntil?: string;
}

export interface HistoryEvent {
  id: string;
  reminderId: string;
  occurrenceId: string;
  type: HistoryEventType;
  occurredAt: string;
}

export interface CreateReminderInput {
  id: string;
  ownerId: string;
  title: string;
  notes?: string;
  tags?: readonly string[];
  schedule: Schedule;
  timezone: string;
  sound?: ReminderSound;
  now: string;
}

export const SNOOZE_MINUTES = [5, 10, 15, 30, 60] as const;
export const HISTORY_RETENTION_DAYS = 30;

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;
const WEEKDAY_NAMES = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
] as const;

export function validateCronExpression(expression: string): {
  valid: boolean;
  error?: string;
} {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: "Use five fields: minute, hour, day, month, weekday.",
    };
  }
  const supported =
    isSupportedCronField(fields[0] ?? "", 0, 59) &&
    isSupportedCronField(fields[1] ?? "", 0, 23) &&
    isSupportedCronField(fields[2] ?? "", 1, 31) &&
    isSupportedCronField(fields[3] ?? "", 1, 12, MONTH_NAMES) &&
    isSupportedCronField(fields[4] ?? "", 0, 7, WEEKDAY_NAMES);
  if (!supported) {
    return {
      valid: false,
      error: "The schedule uses an unsupported cron field.",
    };
  }
  try {
    CronExpressionParser.parse(expression);
    return { valid: true };
  } catch {
    return {
      valid: false,
      error: "The schedule is not a valid five-field cron expression.",
    };
  }
}

function isSupportedCronField(
  field: string,
  minimum: number,
  maximum: number,
  names: readonly string[] = [],
): boolean {
  if (!field) return false;
  return field.split(",").every((part) => {
    const segments = part.split("/");
    if (segments.length > 2) return false;
    const [base, step] = segments;
    if (!base) return false;
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1)) {
      return false;
    }
    if (base === "*") return true;
    const value = cronFieldValue(base, minimum, maximum, names);
    if (value !== null) return true;
    const bounds = base.split("-");
    if (bounds.length !== 2) return false;
    const lower = cronFieldValue(bounds[0] ?? "", minimum, maximum, names);
    const upper = cronFieldValue(bounds[1] ?? "", minimum, maximum, names);
    return lower !== null && upper !== null && lower <= upper;
  });
}

function cronFieldValue(
  value: string,
  minimum: number,
  maximum: number,
  names: readonly string[],
): number | null {
  const numeric = /^\d+$/.test(value) ? Number(value) : null;
  const nameIndex = names.indexOf(value.toUpperCase());
  const parsed = numeric ?? (nameIndex >= 0 ? minimum + nameIndex : null);
  return parsed !== null && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

export function parseCronSchedule(
  expression: string,
): Extract<Schedule, { kind: "cron" }> {
  const result = validateCronExpression(expression);
  if (!result.valid) throw new Error(result.error);
  return { kind: "cron", expression };
}

export function validateSchedule(schedule: Schedule): void {
  if (schedule.kind === "once") {
    if (!Number.isFinite(Date.parse(schedule.at)))
      throw new Error("A valid date is required.");
    return;
  }
  const result = validateCronExpression(schedule.expression);
  if (!result.valid) throw new Error(result.error);
  if (
    schedule.occurrenceLimit !== undefined &&
    (!Number.isInteger(schedule.occurrenceLimit) ||
      schedule.occurrenceLimit < 1)
  ) {
    throw new Error("Occurrence limit must be a positive integer.");
  }
  if (
    schedule.startAt !== undefined &&
    !Number.isFinite(Date.parse(schedule.startAt))
  ) {
    throw new Error("Schedule start must be a valid date.");
  }
  if (
    schedule.endAt !== undefined &&
    !Number.isFinite(Date.parse(schedule.endAt))
  ) {
    throw new Error("Schedule end must be a valid date.");
  }
  if (
    schedule.startAt &&
    schedule.endAt &&
    Date.parse(schedule.startAt) > Date.parse(schedule.endAt)
  ) {
    throw new Error("Schedule end must follow its start.");
  }
}

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("A valid IANA timezone is required.");
  }
}

export function createReminder(input: CreateReminderInput): Reminder {
  const title = input.title.trim();
  if (!title) throw new Error("Reminder title is required.");
  validateSchedule(input.schedule);
  validateTimezone(input.timezone);
  return {
    id: input.id,
    ownerId: input.ownerId,
    title,
    notes: input.notes?.trim() ?? "",
    tags: [
      ...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
    ],
    schedule: input.schedule,
    timezone: input.timezone,
    sound: input.sound ?? { mode: "default" },
    status: "active",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function updateReminder(
  reminder: Reminder,
  changes: Partial<
    Pick<
      Reminder,
      "title" | "notes" | "tags" | "schedule" | "timezone" | "sound"
    >
  >,
  now: string,
): Reminder {
  const title = (changes.title ?? reminder.title).trim();
  const notes = (changes.notes ?? reminder.notes).trim();
  const tags = [
    ...new Set(
      (changes.tags ?? reminder.tags).map((tag) => tag.trim()).filter(Boolean),
    ),
  ];
  const updated = {
    ...reminder,
    ...changes,
    title,
    notes,
    tags,
    revision: reminder.revision + 1,
    updatedAt: now,
  };
  if (!updated.title) throw new Error("Reminder title is required.");
  validateSchedule(updated.schedule);
  validateTimezone(updated.timezone);
  return updated;
}

function transition(
  reminder: Reminder,
  status: ReminderStatus,
  now?: string,
): Reminder {
  return {
    ...reminder,
    status,
    revision: reminder.revision + 1,
    updatedAt: now ?? reminder.updatedAt,
  };
}

export function setReminderEnabled(
  reminder: Reminder,
  enabled: boolean,
  now?: string,
): Reminder {
  if (reminder.status === "archived")
    throw new Error("Restore an archived reminder first.");
  return transition(reminder, enabled ? "active" : "disabled", now);
}

export function archiveReminder(reminder: Reminder, now?: string): Reminder {
  return transition(reminder, "archived", now);
}

export function restoreReminder(reminder: Reminder, now?: string): Reminder {
  if (reminder.status !== "archived") return reminder;
  return transition(reminder, "active", now);
}

export function duplicateReminder(
  reminder: Reminder,
  id: string,
  now: string,
): Reminder {
  return createReminder({
    ...reminder,
    id,
    now,
    tags: reminder.tags,
  });
}

export function dismissOccurrence(
  occurrence: Occurrence,
  now: string,
): Occurrence {
  return { ...occurrence, status: "dismissed", actedAt: now };
}

export function postponeOccurrence(
  occurrence: Occurrence,
  minutes: (typeof SNOOZE_MINUTES)[number],
  now: string,
): Occurrence {
  if (!SNOOZE_MINUTES.includes(minutes))
    throw new Error("Unsupported snooze duration.");
  return {
    ...occurrence,
    status: "postponed",
    actedAt: now,
    snoozedUntil: new Date(Date.parse(now) + minutes * 60_000).toISOString(),
  };
}

export function nextOccurrences(
  schedule: Schedule,
  timezone: string,
  after: Date,
  count = 5,
): Date[] {
  if (count < 1) return [];
  if (schedule.kind === "once") {
    const occurrence = new Date(schedule.at);
    return occurrence > after ? [occurrence] : [];
  }
  const interval = CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    startDate: schedule.startAt,
    endDate: schedule.endAt,
    tz: timezone,
  });
  const capped = Math.min(count, schedule.occurrenceLimit ?? count);
  return interval.take(capped).map((value) => value.toDate());
}

export function describeSchedule(
  schedule: Schedule,
  locale: "en" | "pt-BR",
): string {
  if (schedule.kind === "once") {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(schedule.at));
  }
  const fields = schedule.expression.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = fields;
  if (
    minute === "*" &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    return locale === "pt-BR" ? "A cada minuto" : "Every minute";
  }
  if (
    minute?.startsWith("*/") &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    const interval = minute.slice(2);
    return locale === "pt-BR"
      ? `A cada ${interval} minutos`
      : `Every ${interval} minutes`;
  }
  if (
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    day === "*" &&
    month === "*"
  ) {
    const time = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;
    if (weekday === "*")
      return locale === "pt-BR"
        ? `Todos os dias às ${time}`
        : `Every day at ${time}`;
    return locale === "pt-BR"
      ? `Nos dias selecionados às ${time}`
      : `On selected weekdays at ${time}`;
  }
  return locale === "pt-BR"
    ? `Agenda cron: ${schedule.expression}`
    : `Cron schedule: ${schedule.expression}`;
}

export function historyCutoff(now: Date): Date {
  return new Date(now.getTime() - HISTORY_RETENTION_DAYS * 86_400_000);
}
