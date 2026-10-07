import { CronExpressionParser } from "cron-parser";

export type ReminderStatus = "active" | "disabled" | "archived";
export type OccurrenceStatus =
  | "scheduled"
  | "triggered"
  | "delivering"
  | "dismissed"
  | "completed"
  | "postponed"
  | "missed"
  | "delivery-failed";
export type HistoryEventType =
  | "triggered"
  | "dismissed"
  | "completed"
  | "postponed"
  | "missed"
  | "delivery-failed";

export type NotificationAction = "dismiss" | "snooze" | "complete";

export type ReminderSound = { mode: "default" | "silent" | "vibrate" };

export interface RecurrenceBounds {
  startAt?: string;
  endAt?: string;
  occurrenceLimit?: number;
}

export type Schedule =
  | { kind: "once"; at: string }
  | ({ kind: "daily-times"; times: readonly string[] } & RecurrenceBounds)
  | ({
      kind: "cron";
      expression: string;
    } & RecurrenceBounds);

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

export const SNOOZE_MINUTES = [5, 10, 15] as const;
export const HISTORY_RETENTION_DAYS = 30;
export const MAX_DAILY_TIMES = 24;
const REMINDER_ID_PATTERN = /^[a-z0-9_-]+$/;
const DAILY_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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
    if (strictScheduleTimestamp(schedule.at) === null)
      throw new Error("A valid date is required.");
    return;
  }
  if (schedule.kind === "daily-times") {
    if (schedule.times.length < 2)
      throw new Error("At least two daily times are required.");
    if (schedule.times.length > MAX_DAILY_TIMES)
      throw new Error(
        `Daily schedules support up to ${MAX_DAILY_TIMES} times.`,
      );
    const normalized = schedule.times.map((time) => time.trim());
    if (normalized.some((time) => !DAILY_TIME_PATTERN.test(time)))
      throw new Error("Daily times must use HH:MM in 24-hour format.");
    if (new Set(normalized).size !== normalized.length)
      throw new Error("Daily times must be unique.");
  } else {
    const result = validateCronExpression(schedule.expression);
    if (!result.valid) throw new Error(result.error);
  }
  if (
    schedule.occurrenceLimit !== undefined &&
    (!Number.isSafeInteger(schedule.occurrenceLimit) ||
      schedule.occurrenceLimit < 1)
  ) {
    throw new Error("Occurrence limit must be a positive integer.");
  }
  if (
    schedule.startAt !== undefined &&
    strictScheduleTimestamp(schedule.startAt) === null
  ) {
    throw new Error("Schedule start must be a valid date.");
  }
  if (
    schedule.endAt !== undefined &&
    strictScheduleTimestamp(schedule.endAt) === null
  ) {
    throw new Error("Schedule end must be a valid date.");
  }
  if (
    schedule.startAt &&
    schedule.endAt &&
    (strictScheduleTimestamp(schedule.startAt) ?? 0) >
      (strictScheduleTimestamp(schedule.endAt) ?? 0)
  ) {
    throw new Error("Schedule end must follow its start.");
  }
}

function strictScheduleTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!match || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isValidScheduleTimestamp(value: string): boolean {
  return strictScheduleTimestamp(value) !== null;
}

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("A valid IANA timezone is required.");
  }
}

export function createReminder(input: CreateReminderInput): Reminder {
  if (!isValidReminderId(input.id))
    throw new Error("Reminder ID contains unsupported characters.");
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

export function isValidReminderId(id: string): boolean {
  return REMINDER_ID_PATTERN.test(id);
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

export function completeOccurrence(
  occurrence: Occurrence,
  now: string,
): Occurrence {
  return {
    ...occurrence,
    status: "completed",
    actedAt: now,
    snoozedUntil: undefined,
  };
}

export function postponeOccurrence(
  occurrence: Occurrence,
  minutes: number,
  now: string,
  nextOccurrenceAt: string | null = null,
): Occurrence {
  const postponement = resolvePostponement(minutes, now, nextOccurrenceAt);
  return {
    ...occurrence,
    status: "postponed",
    actedAt: now,
    snoozedUntil: postponement.until,
  };
}

export interface Postponement {
  until: string;
  mergeIntoNext: boolean;
}

export function resolvePostponement(
  selection: number | "next" | { until: string },
  now: string,
  nextOccurrenceAt: string | null,
): Postponement {
  const nowTime = Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error("Invalid current time.");
  let targetTime: number;
  if (selection === "next") {
    if (!nextOccurrenceAt)
      throw new Error("This reminder has no next occurrence.");
    targetTime = Date.parse(nextOccurrenceAt);
  } else if (typeof selection === "number") {
    if (!Number.isSafeInteger(selection) || selection < 1)
      throw new Error("Enter a positive whole number of minutes.");
    targetTime = nowTime + selection * 60_000;
  } else {
    targetTime = Date.parse(selection.until);
  }
  if (
    !Number.isFinite(targetTime) ||
    !Number.isFinite(new Date(targetTime).getTime())
  )
    throw new Error("Choose a valid postponement time.");
  if (targetTime <= nowTime)
    throw new Error("The postponement time has passed. Choose a future time.");
  const nextTime = nextOccurrenceAt ? Date.parse(nextOccurrenceAt) : null;
  if (nextTime !== null && (!Number.isFinite(nextTime) || nextTime <= nowTime))
    throw new Error("The next occurrence has changed. Refresh and try again.");
  if (nextTime !== null && targetTime > nextTime)
    throw new Error("Choose a time no later than the next occurrence.");
  return {
    until: new Date(targetTime).toISOString(),
    mergeIntoNext: nextTime !== null && targetTime === nextTime,
  };
}

export function nextPostponementAt(
  reminder: Pick<Reminder, "schedule" | "timezone" | "status">,
  now: Date,
  occurrenceCount?: number,
): string | null {
  if (reminder.status !== "active") return null;
  const { schedule, timezone } = reminder;
  if (
    schedule.kind !== "once" &&
    schedule.occurrenceLimit !== undefined &&
    occurrenceCount !== undefined &&
    occurrenceCount >= schedule.occurrenceLimit
  )
    return null;
  return nextOccurrences(schedule, timezone, now, 1)[0]?.toISOString() ?? null;
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
  if (schedule.endAt && Date.parse(schedule.endAt) <= after.getTime())
    return [];
  const capped = Math.min(count, schedule.occurrenceLimit ?? count);
  const forExpression = (expression: string): Date[] => {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: after,
      startDate: inclusiveStartDate(schedule.startAt),
      endDate: schedule.endAt,
      tz: timezone,
    });
    const dates: Date[] = [];
    while (dates.length < capped && interval.hasNext())
      dates.push(interval.next().toDate());
    return dates;
  };
  if (schedule.kind === "daily-times") {
    const candidates = schedule.times.flatMap((time) => {
      const [hour, minute] = time.split(":");
      return forExpression(`${Number(minute)} ${Number(hour)} * * *`);
    });
    return [
      ...new Map(
        candidates.map((candidate) => [candidate.toISOString(), candidate]),
      ).values(),
    ]
      .sort((left, right) => left.getTime() - right.getTime())
      .slice(0, capped);
  }
  return forExpression(schedule.expression);
}

function inclusiveStartDate(value: string | undefined): Date | undefined {
  return value ? new Date(Date.parse(value) - 1) : undefined;
}

export function describeSchedule(
  schedule: Schedule,
  locale: "en" | "pt-BR",
  timezone?: string,
): string {
  const frequency = describeScheduleFrequency(schedule, locale);
  if (schedule.kind === "once") return frequency;
  const endings: string[] = [];
  if (schedule.endAt) {
    const end = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(schedule.endAt));
    endings.push(locale === "pt-BR" ? `até ${end}` : `until ${end}`);
  }
  if (schedule.occurrenceLimit !== undefined) {
    const count = schedule.occurrenceLimit;
    endings.push(
      locale === "pt-BR"
        ? `${count} ${count === 1 ? "ocorrência" : "ocorrências"} no total`
        : `${count} ${count === 1 ? "occurrence" : "occurrences"} total`,
    );
  }
  return [frequency, ...endings].join(" · ");
}

function describeScheduleFrequency(
  schedule: Schedule,
  locale: "en" | "pt-BR",
): string {
  if (schedule.kind === "once") {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(schedule.at));
  }
  if (schedule.kind === "daily-times") {
    const times = [...schedule.times].sort();
    const formattedTimes = new Intl.ListFormat(locale, {
      style: "long",
      type: "conjunction",
    }).format(times);
    return locale === "pt-BR"
      ? `Todos os dias às ${formattedTimes}`
      : `Every day at ${formattedTimes}`;
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
    if (interval === "1")
      return locale === "pt-BR" ? "A cada minuto" : "Every minute";
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
    if (weekday === "1-5")
      return locale === "pt-BR"
        ? `Todos os dias úteis às ${time}`
        : `Every weekday at ${time}`;
    return locale === "pt-BR"
      ? `Nos dias selecionados às ${time}`
      : `On selected weekdays at ${time}`;
  }
  if (
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    /^\d+$/.test(day ?? "") &&
    month === "*" &&
    weekday === "*"
  ) {
    const time = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;
    return locale === "pt-BR"
      ? `Todo mês, no dia ${day}, às ${time}`
      : `Every month on day ${day} at ${time}`;
  }
  if (
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    /^\d+$/.test(day ?? "") &&
    /^\d+$/.test(month ?? "") &&
    weekday === "*"
  ) {
    const time = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;
    const monthName = new Intl.DateTimeFormat(locale, {
      month: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2024, Number(month) - 1, 1)));
    return locale === "pt-BR"
      ? `Todos os anos em ${day} de ${monthName} às ${time}`
      : `Every year on ${monthName} ${day} at ${time}`;
  }
  return locale === "pt-BR"
    ? `Agenda cron: ${schedule.expression}`
    : `Cron schedule: ${schedule.expression}`;
}

export function historyCutoff(now: Date): Date {
  return new Date(now.getTime() - HISTORY_RETENTION_DAYS * 86_400_000);
}
