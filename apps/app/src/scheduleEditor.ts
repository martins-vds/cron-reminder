import { MAX_DAILY_TIMES, type Schedule } from "@cron-reminder/domain";

export type ScheduleEditorKind =
  | "once"
  | "interval"
  | "daily"
  | "multiple-daily"
  | "weekdays"
  | "monthly"
  | "yearly"
  | "advanced";

export interface ScheduleEditorState {
  kind: ScheduleEditorKind;
  onceAt: string;
  intervalMinutes: string;
  time: string;
  dailyTimes: string[];
  monthDay: string;
  yearMonth: string;
  yearDay: string;
  advancedCron: string;
}

const defaultCron = "0 9 * * *";

export function createScheduleEditorState(
  schedule: Schedule | undefined,
  now = new Date(),
): ScheduleEditorState {
  const defaults: ScheduleEditorState = {
    kind: "daily",
    onceAt: new Date(now.getTime() + 3_600_000).toISOString(),
    intervalMinutes: "5",
    time: "09:00",
    dailyTimes: ["09:00", "18:00"],
    monthDay: "1",
    yearMonth: "1",
    yearDay: "1",
    advancedCron: schedule?.kind === "cron" ? schedule.expression : defaultCron,
  };

  if (!schedule) return defaults;
  if (schedule.kind === "once") {
    return { ...defaults, kind: "once", onceAt: schedule.at };
  }
  if (schedule.kind === "daily-times") {
    return {
      ...defaults,
      kind: "multiple-daily",
      dailyTimes: [...schedule.times],
    };
  }
  if (
    schedule.startAt !== undefined ||
    schedule.endAt !== undefined ||
    schedule.occurrenceLimit !== undefined
  ) {
    return { ...defaults, kind: "advanced" };
  }

  const expression = schedule.expression.trim().replace(/\s+/g, " ");
  const dailyTimes = parseDailyCronTimes(expression);
  if (dailyTimes) {
    return {
      ...defaults,
      kind: "multiple-daily",
      dailyTimes,
    };
  }
  const interval = expression.match(/^\*\/(\d{1,2}) \* \* \* \*$/);
  if (interval && isIntegerInRange(interval[1], 1, 59)) {
    return {
      ...defaults,
      kind: "interval",
      intervalMinutes: interval[1] ?? defaults.intervalMinutes,
    };
  }

  const weekdays = expression.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/);
  if (weekdays && isValidTimeParts(weekdays[2], weekdays[1])) {
    return {
      ...defaults,
      kind: "weekdays",
      time: formatTime(weekdays[2], weekdays[1]),
    };
  }

  const daily = expression.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily && isValidTimeParts(daily[2], daily[1])) {
    return {
      ...defaults,
      kind: "daily",
      time: formatTime(daily[2], daily[1]),
    };
  }

  const yearly = expression.match(
    /^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*$/,
  );
  if (
    yearly &&
    isValidTimeParts(yearly[2], yearly[1]) &&
    isValidAnnualDate(yearly[4], yearly[3])
  ) {
    return {
      ...defaults,
      kind: "yearly",
      time: formatTime(yearly[2], yearly[1]),
      yearMonth: yearly[4] ?? defaults.yearMonth,
      yearDay: yearly[3] ?? defaults.yearDay,
    };
  }

  const monthly = expression.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/);
  if (
    monthly &&
    isValidTimeParts(monthly[2], monthly[1]) &&
    isIntegerInRange(monthly[3], 1, 31)
  ) {
    return {
      ...defaults,
      kind: "monthly",
      time: formatTime(monthly[2], monthly[1]),
      monthDay: monthly[3] ?? defaults.monthDay,
    };
  }

  return { ...defaults, kind: "advanced" };
}

export function buildCronExpression(state: ScheduleEditorState): string {
  if (state.kind === "advanced") return state.advancedCron;
  if (state.kind === "interval") {
    return `*/${state.intervalMinutes.trim()} * * * *`;
  }

  const time = parseTime(state.time);
  if (!time) return "";
  const prefix = `${time.minute} ${time.hour}`;
  if (state.kind === "daily") return `${prefix} * * *`;
  if (state.kind === "weekdays") return `${prefix} * * 1-5`;
  if (state.kind === "monthly") {
    return `${prefix} ${state.monthDay.trim()} * *`;
  }
  if (state.kind === "yearly") {
    return `${prefix} ${state.yearDay.trim()} ${state.yearMonth.trim()} *`;
  }
  return "";
}

export function hasValidScheduleEditorValues(
  state: ScheduleEditorState,
): boolean {
  if (state.kind === "once" || state.kind === "advanced") return true;
  if (state.kind === "multiple-daily") {
    const times = normalizeDailyTimes(state.dailyTimes);
    return (
      times.length >= 2 &&
      times.length <= MAX_DAILY_TIMES &&
      times.every((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) &&
      new Set(times).size === times.length
    );
  }
  if (state.kind === "interval") {
    return isIntegerInRange(state.intervalMinutes, 1, 59);
  }
  if (!parseTime(state.time)) return false;
  if (state.kind === "monthly") {
    return isIntegerInRange(state.monthDay, 1, 31);
  }
  if (state.kind === "yearly") {
    return isValidAnnualDate(state.yearMonth, state.yearDay);
  }
  return true;
}

export function normalizeDailyTimes(times: readonly string[]): string[] {
  return times.map((time) => time.trim()).sort();
}

function parseDailyCronTimes(expression: string): string[] | null {
  const match = expression.match(/^([\d,]+) ([\d,]+) \* \* \*$/);
  if (!match) return null;
  const minutes = parseCronNumberList(match[1], 0, 59);
  const hours = parseCronNumberList(match[2], 0, 23);
  if (
    !minutes ||
    !hours ||
    minutes.length * hours.length < 2 ||
    minutes.length * hours.length > MAX_DAILY_TIMES
  ) {
    return null;
  }
  return hours
    .flatMap((hour) =>
      minutes.map(
        (minute) =>
          `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ),
    )
    .sort();
}

function parseCronNumberList(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number[] | null {
  if (!value) return null;
  const parts = value.split(",");
  if (
    parts.some((part) => !isIntegerInRange(part, minimum, maximum)) ||
    new Set(parts).size !== parts.length
  ) {
    return null;
  }
  return parts.map(Number);
}

function parseTime(value: string): { hour: string; minute: string } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match || !isValidTimeParts(match[1], match[2])) return null;
  return {
    hour: String(Number(match[1])).padStart(2, "0"),
    minute: String(Number(match[2])).padStart(2, "0"),
  };
}

function formatTime(
  hour: string | undefined,
  minute: string | undefined,
): string {
  return `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

function isValidTimeParts(
  hour: string | undefined,
  minute: string | undefined,
): boolean {
  return isIntegerInRange(hour, 0, 23) && isIntegerInRange(minute, 0, 59);
}

function isValidAnnualDate(
  month: string | undefined,
  day: string | undefined,
): boolean {
  if (!isIntegerInRange(month, 1, 12) || !isIntegerInRange(day, 1, 31)) {
    return false;
  }
  const monthNumber = Number(month);
  const maximumDay = new Date(Date.UTC(2024, monthNumber, 0)).getUTCDate();
  return Number(day) <= maximumDay;
}

function isIntegerInRange(
  value: string | undefined,
  minimum: number,
  maximum: number,
): boolean {
  if (!value || !/^\d+$/.test(value.trim())) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}
