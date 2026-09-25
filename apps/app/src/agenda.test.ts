import { describe, expect, it } from "vitest";
import type { Reminder } from "@cron-reminder/domain";
import {
  buildAgendaItems,
  groupAgendaItems,
  type StoredAgendaOccurrence,
} from "./agenda";

const reminder: Reminder = {
  id: "report",
  ownerId: "user-1",
  title: "Send report",
  notes: "",
  tags: ["work"],
  schedule: { kind: "cron", expression: "0 12 * * *" },
  timezone: "UTC",
  sound: { mode: "default" },
  status: "active",
  revision: 1,
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T09:00:00.000Z",
};

describe("agenda", () => {
  it("merges recorded states with the next calculated occurrence", () => {
    const occurrences: StoredAgendaOccurrence[] = [
      {
        id: "report:missed",
        reminder_id: reminder.id,
        scheduled_at: "2026-09-24T12:00:00.000Z",
        status: "missed",
        acted_at: null,
        snoozed_until: null,
      },
      {
        id: "report:postponed",
        reminder_id: reminder.id,
        scheduled_at: "2026-09-25T08:00:00.000Z",
        status: "postponed",
        acted_at: "2026-09-25T08:01:00.000Z",
        snoozed_until: "2026-09-25T11:00:00.000Z",
      },
      {
        id: "report:due",
        reminder_id: reminder.id,
        scheduled_at: "2026-09-25T09:00:00.000Z",
        status: "triggered",
        acted_at: null,
        snoozed_until: null,
      },
    ];

    const items = buildAgendaItems(
      [reminder],
      occurrences,
      new Date("2026-09-25T10:00:00.000Z"),
    );

    expect(items.map(({ status }) => status)).toEqual([
      "missed",
      "due",
      "postponed",
      "upcoming",
    ]);
    expect(items.find(({ status }) => status === "due")?.actionable).toBe(true);
    expect(
      items.find(({ status }) => status === "postponed")?.effectiveAt,
    ).toBe("2026-09-25T11:00:00.000Z");
    expect(items.at(-1)?.scheduledAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("does not duplicate a calculated occurrence already recorded", () => {
    const scheduledAt = "2026-09-25T12:00:00.000Z";
    const items = buildAgendaItems(
      [reminder],
      [
        {
          id: `${reminder.id}:${scheduledAt}`,
          reminder_id: reminder.id,
          scheduled_at: scheduledAt,
          status: "triggered",
          acted_at: null,
          snoozed_until: null,
        },
      ],
      new Date("2026-09-25T10:00:00.000Z"),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("due");
  });

  it("groups overdue, today, tomorrow, and later in the viewer timezone", () => {
    const items = buildAgendaItems(
      [
        reminder,
        {
          ...reminder,
          id: "tomorrow",
          title: "Tomorrow",
          schedule: { kind: "once", at: "2026-09-26T08:00:00.000Z" },
        },
        {
          ...reminder,
          id: "later",
          title: "Later",
          schedule: { kind: "once", at: "2026-09-29T08:00:00.000Z" },
        },
      ],
      [
        {
          id: "overdue",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-25T09:00:00.000Z",
          status: "triggered",
          acted_at: null,
          snoozed_until: null,
        },
      ],
      new Date("2026-09-25T10:00:00.000Z"),
    );
    const groups = groupAgendaItems(
      items,
      new Date("2026-09-25T10:00:00.000Z"),
      "UTC",
    );

    expect(groups.overdue.map(({ id }) => id)).toEqual(["overdue"]);
    expect(groups.today.map(({ reminderId }) => reminderId)).toEqual([
      "report",
    ]);
    expect(groups.tomorrow.map(({ reminderId }) => reminderId)).toEqual([
      "tomorrow",
    ]);
    expect(groups.later.map(({ reminderId }) => reminderId)).toEqual(["later"]);
  });
});
