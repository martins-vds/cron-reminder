import { describe, expect, it } from "vitest";
import type { Reminder } from "@cron-reminder/domain";
import {
  buildAgendaItems,
  groupAgendaItems,
  groupAgendaItemsByReminder,
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
      "due",
      "postponed",
      "upcoming",
    ]);
    expect(items.find(({ status }) => status === "due")).toMatchObject({
      dismissible: true,
      snoozable: true,
    });
    expect(items.find(({ status }) => status === "missed")).toBeUndefined();
    expect(
      items.find(({ status }) => status === "postponed")?.effectiveAt,
    ).toBe("2026-09-25T11:00:00.000Z");
    expect(items.at(-1)?.scheduledAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it.each([
    "scheduled",
    "triggered",
    "delivering",
    "delivery-failed",
    "missed",
    "postponed",
  ] as const)("hides archived reminders with %s occurrences", (status) => {
    const active = { ...reminder, id: "active-report" };
    const occurrences: StoredAgendaOccurrence[] = [
      {
        id: "archived-record",
        reminder_id: reminder.id,
        scheduled_at: "2026-09-25T09:00:00.000Z",
        status,
        acted_at: null,
        snoozed_until:
          status === "postponed" ? "2026-09-25T11:00:00.000Z" : null,
      },
      {
        id: "archived-future",
        reminder_id: reminder.id,
        scheduled_at: "2026-09-26T12:00:00.000Z",
        status: "scheduled",
        acted_at: null,
        snoozed_until: null,
      },
      {
        id: "active-record",
        reminder_id: active.id,
        scheduled_at: "2026-09-25T09:00:00.000Z",
        status: "triggered",
        acted_at: null,
        snoozed_until: null,
      },
    ];
    const originalOccurrences = structuredClone(occurrences);
    const items = buildAgendaItems(
      [{ ...reminder, status: "archived" }, active],
      occurrences,
      new Date("2026-09-25T10:00:00.000Z"),
    );
    expect(
      items.filter(({ reminderId }) => reminderId === reminder.id),
    ).toEqual([]);
    expect(items.map(({ reminderId }) => reminderId)).toEqual([
      active.id,
      active.id,
    ]);
    expect(occurrences).toEqual(originalOccurrences);
  });

  it("keeps existing disabled-reminder occurrences dismissible", () => {
    const items = buildAgendaItems(
      [{ ...reminder, status: "disabled" }],
      [
        {
          id: "disabled-record",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-25T09:00:00.000Z",
          status: "triggered",
          acted_at: null,
          snoozed_until: null,
        },
      ],
      new Date("2026-09-25T10:00:00.000Z"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "disabled-record",
      dismissible: true,
      snoozable: false,
    });
  });

  it.each([
    "scheduled",
    "triggered",
    "delivering",
    "delivery-failed",
    "missed",
    "postponed",
  ] as const)(
    "hides completed reminders with %s occurrences and projects no future reminders",
    (status) => {
      const occurrences: StoredAgendaOccurrence[] = [
        {
          id: "finished",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-25T09:00:00.000Z",
          status,
          acted_at: null,
          snoozed_until:
            status === "postponed" ? "2026-09-25T11:00:00.000Z" : null,
        },
      ];
      const original = structuredClone(occurrences);
      expect(
        buildAgendaItems(
          [{ ...reminder, status: "completed" }],
          occurrences,
          new Date("2026-09-25T10:00:00.000Z"),
        ),
      ).toEqual([]);
      expect(occurrences).toEqual(original);
    },
  );
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

  it("keeps only the latest missed occurrence per reminder regardless of input order", () => {
    const missed = (
      id: string,
      reminderId: string,
      scheduledAt: string,
    ): StoredAgendaOccurrence => ({
      id,
      reminder_id: reminderId,
      scheduled_at: scheduledAt,
      status: "missed",
      acted_at: null,
      snoozed_until: null,
    });
    const occurrences = [
      missed("newest", reminder.id, "2026-09-25T09:00:00.000Z"),
      missed("other", "backup", "2026-09-24T10:00:00.000Z"),
      missed("oldest", reminder.id, "2026-09-24T09:00:00.000Z"),
    ];
    const items = buildAgendaItems(
      [reminder, { ...reminder, id: "backup" }],
      occurrences,
      new Date("2026-09-25T10:00:00.000Z"),
    );
    expect(
      items.filter(({ status }) => status === "missed").map(({ id }) => id),
    ).toEqual(["other", "newest"]);
    expect(items.find(({ id }) => id === "newest")).toMatchObject({
      dismissible: true,
      snoozable: true,
    });
    expect(occurrences).toHaveLength(3);
  });

  it.each(["dismissed", "completed", "postponed"] as const)(
    "does not resurrect older missed occurrences after the latest is %s",
    (status) => {
      const items = buildAgendaItems(
        [reminder],
        [
          {
            id: "older",
            reminder_id: reminder.id,
            scheduled_at: "2026-09-24T09:00:00.000Z",
            status: "missed",
            acted_at: null,
            snoozed_until: null,
          },
          {
            id: "latest",
            reminder_id: reminder.id,
            scheduled_at: "2026-09-25T09:00:00.000Z",
            status,
            acted_at: "2026-09-25T09:01:00.000Z",
            snoozed_until:
              status === "postponed" ? "2026-09-25T11:00:00.000Z" : null,
          },
        ],
        new Date("2026-09-25T10:00:00.000Z"),
      );
      expect(items.some(({ id }) => id === "older")).toBe(false);
      expect(items.some(({ id }) => id === "latest")).toBe(
        status === "postponed",
      );
      expect(items.at(-1)?.status).toBe("upcoming");
    },
  );

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

  it("folds an occurrence postponed to the next into one upcoming card", () => {
    const items = buildAgendaItems(
      [reminder],
      [
        {
          id: "folded",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-25T09:00:00.000Z",
          status: "postponed",
          acted_at: "2026-09-25T10:00:00.000Z",
          snoozed_until: "2026-09-25T12:00:00.000Z",
          postponed_to_next: true,
        },
      ],
      new Date("2026-09-25T10:00:00.000Z"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: "upcoming",
      scheduledAt: "2026-09-25T12:00:00.000Z",
    });
  });

  it("does not offer a next occurrence after the repeat limit is exhausted", () => {
    const items = buildAgendaItems(
      [
        {
          ...reminder,
          schedule: {
            kind: "cron",
            expression: "0 12 * * *",
            occurrenceLimit: 1,
          },
        },
      ],
      [
        {
          id: "final",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-25T09:00:00.000Z",
          status: "missed",
          acted_at: null,
          snoozed_until: null,
        },
      ],
      new Date("2026-09-25T10:00:00.000Z"),
      new Map([[reminder.id, 1]]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.nextOccurrenceAt).toBeNull();
  });

  it("keeps a delivered postponement actionable at its effective time", () => {
    const items = buildAgendaItems(
      [reminder],
      [
        {
          id: "postponed-delivery",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-24T09:00:00.000Z",
          status: "triggered",
          acted_at: "2026-09-25T10:00:00.000Z",
          snoozed_until: "2026-09-25T10:00:00.000Z",
        },
        {
          id: "newer-regular",
          reminder_id: reminder.id,
          scheduled_at: "2026-09-25T09:00:00.000Z",
          status: "completed",
          acted_at: "2026-09-25T09:01:00.000Z",
          snoozed_until: null,
        },
      ],
      new Date("2026-09-25T10:01:00.000Z"),
    );
    expect(items.find(({ id }) => id === "postponed-delivery")).toMatchObject({
      effectiveAt: "2026-09-25T10:00:00.000Z",
      status: "due",
      snoozable: true,
    });
  });

  it("groups repeated agenda items by reminder with an effective time range", () => {
    const grouped = groupAgendaItemsByReminder([
      {
        id: "report:later",
        reminderId: "report",
        reminderTitle: "Send report",
        scheduledAt: "2026-09-25T09:30:00.000Z",
        effectiveAt: "2026-09-25T09:30:00.000Z",
        status: "due",
        dismissible: true,
        snoozable: true,
      },
      {
        id: "backup",
        reminderId: "backup",
        reminderTitle: "Back up files",
        scheduledAt: "2026-09-25T09:00:00.000Z",
        effectiveAt: "2026-09-25T09:00:00.000Z",
        status: "due",
        dismissible: true,
        snoozable: true,
      },
      {
        id: "report:earlier",
        reminderId: "report",
        reminderTitle: "Send report",
        scheduledAt: "2026-09-25T08:00:00.000Z",
        effectiveAt: "2026-09-25T08:00:00.000Z",
        status: "missed",
        dismissible: true,
        snoozable: false,
      },
    ]);

    expect(grouped.map(({ reminderId }) => reminderId)).toEqual([
      "report",
      "backup",
    ]);
    expect(grouped[0]).toMatchObject({
      reminderTitle: "Send report",
      firstEffectiveAt: "2026-09-25T08:00:00.000Z",
      lastEffectiveAt: "2026-09-25T09:30:00.000Z",
    });
    expect(grouped[0]?.items.map(({ id }) => id)).toEqual([
      "report:earlier",
      "report:later",
    ]);
  });
});
