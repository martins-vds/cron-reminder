export interface DailyAnalytics {
  reminderId: string;
  day: string;
  timezone: string;
  completed: number;
  postponed: number;
}

export interface AnalyticsSnapshot {
  availableSince: string;
  fetchedAt: string;
  days: DailyAnalytics[];
}

export type AnalyticsRange = "7" | "30" | "90" | "all";
export interface AnalyticsCounts {
  completed: number;
  postponed: number;
}
export interface AnalyticsBucket extends AnalyticsCounts {
  day: string;
}
export interface AnalyticsSummary {
  totals: AnalyticsCounts;
  reminders: Array<AnalyticsCounts & { reminderId: string }>;
  trend: AnalyticsBucket[];
}

export function localAnalyticsDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function shiftAnalyticsDay(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function bucketDay(day: string, range: AnalyticsRange): string {
  if (range === "all") return `${day.slice(0, 7)}-01`;
  if (range === "90") {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    return shiftAnalyticsDay(day, -(weekday + 6) % 7);
  }
  return day;
}

export function summarizeAnalytics(
  snapshot: AnalyticsSnapshot,
  range: AnalyticsRange,
  now: Date,
): AnalyticsSummary {
  const totals: AnalyticsCounts = { completed: 0, postponed: 0 };
  const reminders = new Map<string, AnalyticsCounts>();
  const trend = new Map<string, AnalyticsCounts>();
  const zones = new Set(snapshot.days.map((row) => row.timezone));
  for (const zone of zones) {
    const today = localAnalyticsDay(now, zone);
    const coverage = localAnalyticsDay(new Date(snapshot.availableSince), zone);
    const start =
      range === "all"
        ? coverage
        : [coverage, shiftAnalyticsDay(today, 1 - Number(range))].sort()[1];
    if (!start) continue;
    // Fill known inactive days, but never invent data before recorded coverage.
    for (let day = start; day <= today; day = shiftAnalyticsDay(day, 1)) {
      const key = bucketDay(day, range);
      if (!trend.has(key)) trend.set(key, { completed: 0, postponed: 0 });
    }
  }
  for (const row of snapshot.days) {
    const today = localAnalyticsDay(now, row.timezone);
    const start =
      range === "all" ? "" : shiftAnalyticsDay(today, 1 - Number(range));
    if (row.day < start || row.day > today) continue;
    totals.completed += row.completed;
    totals.postponed += row.postponed;
    const reminder = reminders.get(row.reminderId) ?? {
      completed: 0,
      postponed: 0,
    };
    reminder.completed += row.completed;
    reminder.postponed += row.postponed;
    reminders.set(row.reminderId, reminder);
    const key = bucketDay(row.day, range);
    const bucket = trend.get(key) ?? { completed: 0, postponed: 0 };
    bucket.completed += row.completed;
    bucket.postponed += row.postponed;
    trend.set(key, bucket);
  }
  return {
    totals,
    reminders: [...reminders]
      .map(([reminderId, counts]) => ({ reminderId, ...counts }))
      .sort(
        (a, b) =>
          b.completed + b.postponed - a.completed - a.postponed ||
          a.reminderId.localeCompare(b.reminderId),
      ),
    trend: [...trend]
      .map(([day, counts]) => ({ day, ...counts }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}
