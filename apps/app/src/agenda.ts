import {
  nextOccurrences,
  type OccurrenceStatus,
  type Reminder,
} from "@cron-reminder/domain";

export type AgendaGroupKey = "overdue" | "today" | "tomorrow" | "later";
export type AgendaItemStatus = "due" | "missed" | "postponed" | "upcoming";

export interface StoredAgendaOccurrence {
  id: string;
  reminder_id: string;
  scheduled_at: string;
  status: OccurrenceStatus;
  acted_at: string | null;
  snoozed_until: string | null;
}

export interface AgendaItem {
  id: string;
  reminderId: string;
  reminderTitle: string;
  scheduledAt: string;
  effectiveAt: string;
  status: AgendaItemStatus;
  dismissible: boolean;
  snoozable: boolean;
}

export interface AgendaReminderGroup {
  reminderId: string;
  reminderTitle: string;
  items: AgendaItem[];
  firstEffectiveAt: string;
  lastEffectiveAt: string;
}

export type AgendaGroups = Record<AgendaGroupKey, AgendaItem[]>;

const actionableStatuses = new Set<OccurrenceStatus>([
  "triggered",
  "delivering",
  "delivery-failed",
]);

export function buildAgendaItems(
  reminders: readonly Reminder[],
  occurrences: readonly StoredAgendaOccurrence[],
  now: Date,
): AgendaItem[] {
  const remindersById = new Map(
    reminders.map((reminder) => [reminder.id, reminder]),
  );
  const recordedOccurrenceIds = new Set(occurrences.map(({ id }) => id));
  const items = occurrences.flatMap((occurrence) => {
    if (occurrence.status === "dismissed") return [];
    const reminder = remindersById.get(occurrence.reminder_id);
    if (!reminder) return [];
    return [
      {
        id: occurrence.id,
        reminderId: reminder.id,
        reminderTitle: reminder.title,
        scheduledAt: occurrence.scheduled_at,
        effectiveAt:
          occurrence.status === "postponed" && occurrence.snoozed_until
            ? occurrence.snoozed_until
            : occurrence.scheduled_at,
        status: agendaStatus(occurrence.status),
        dismissible: true,
        snoozable: actionableStatuses.has(occurrence.status),
      },
    ];
  });

  for (const reminder of reminders) {
    if (reminder.status !== "active") continue;
    const next = nextOccurrences(
      reminder.schedule,
      reminder.timezone,
      now,
      1,
    )[0];
    if (!next) continue;
    const scheduledAt = next.toISOString();
    const id = `${reminder.id}:${scheduledAt}`;
    if (recordedOccurrenceIds.has(id)) continue;
    items.push({
      id,
      reminderId: reminder.id,
      reminderTitle: reminder.title,
      scheduledAt,
      effectiveAt: scheduledAt,
      status: "upcoming",
      dismissible: false,
      snoozable: false,
    });
  }

  return items.sort(
    (left, right) =>
      Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt) ||
      left.reminderTitle.localeCompare(right.reminderTitle),
  );
}

export function groupAgendaItems(
  items: readonly AgendaItem[],
  now: Date,
  timezone: string,
): AgendaGroups {
  const groups: AgendaGroups = {
    overdue: [],
    today: [],
    tomorrow: [],
    later: [],
  };
  const today = calendarDayNumber(now, timezone);

  for (const item of items) {
    const effective = new Date(item.effectiveAt);
    const dayDifference = calendarDayNumber(effective, timezone) - today;
    const group =
      item.status === "missed" || effective <= now || dayDifference < 0
        ? "overdue"
        : dayDifference === 0
          ? "today"
          : dayDifference === 1
            ? "tomorrow"
            : "later";
    groups[group].push(item);
  }

  return groups;
}

export function groupAgendaItemsByReminder(
  items: readonly AgendaItem[],
): AgendaReminderGroup[] {
  const grouped = new Map<string, AgendaReminderGroup>();

  for (const item of items) {
    const current = grouped.get(item.reminderId);
    if (!current) {
      grouped.set(item.reminderId, {
        reminderId: item.reminderId,
        reminderTitle: item.reminderTitle,
        items: [item],
        firstEffectiveAt: item.effectiveAt,
        lastEffectiveAt: item.effectiveAt,
      });
      continue;
    }

    current.items.push(item);
    if (Date.parse(item.effectiveAt) < Date.parse(current.firstEffectiveAt)) {
      current.firstEffectiveAt = item.effectiveAt;
    }
    if (Date.parse(item.effectiveAt) > Date.parse(current.lastEffectiveAt)) {
      current.lastEffectiveAt = item.effectiveAt;
    }
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort(
        (left, right) =>
          Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt),
      ),
    }))
    .sort(
      (left, right) =>
        Date.parse(left.firstEffectiveAt) -
          Date.parse(right.firstEffectiveAt) ||
        left.reminderTitle.localeCompare(right.reminderTitle),
    );
}

function agendaStatus(status: OccurrenceStatus): AgendaItemStatus {
  if (status === "missed") return "missed";
  if (status === "postponed") return "postponed";
  if (status === "scheduled") return "upcoming";
  return "due";
}

function calendarDayNumber(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find(({ type }) => type === "year")?.value);
  const month = Number(parts.find(({ type }) => type === "month")?.value);
  const day = Number(parts.find(({ type }) => type === "day")?.value);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}
