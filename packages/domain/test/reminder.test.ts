import { describe, expect, it } from "vitest";
import {
  archiveReminder,
  createReminder,
  completeOccurrence,
  completeReminder,
  dismissOccurrence,
  duplicateReminder,
  postponeOccurrence,
  restoreReminder,
  setReminderEnabled,
  updateReminder,
} from "../src/index";

const base = {
  id: "reminder-1",
  ownerId: "user-1",
  title: "Take medicine",
  schedule: { kind: "cron" as const, expression: "0 9 * * *" },
  timezone: "America/Sao_Paulo",
  now: "2026-09-23T12:00:00.000Z",
};

describe("reminder lifecycle", () => {
  it("requires a title", () => {
    expect(() => createReminder({ ...base, title: " " })).toThrow("title");
  });

  it("restricts reminder IDs to stable lowercase ASCII", () => {
    expect(() => createReminder({ ...base, id: "Invalid ID" })).toThrow("ID");
  });

  it("rejects invalid IANA timezones when creating or updating", () => {
    expect(() =>
      createReminder({ ...base, timezone: "Not/A_Timezone" }),
    ).toThrow("timezone");
    expect(() =>
      updateReminder(
        createReminder(base),
        { timezone: "Not/A_Timezone" },
        base.now,
      ),
    ).toThrow("timezone");
  });

  it("normalizes title, notes, and tags when updating", () => {
    const updated = updateReminder(
      createReminder(base),
      {
        title: "  Updated  ",
        notes: "  Notes  ",
        tags: [" home ", "", "home", "work"],
      },
      base.now,
    );
    expect(updated).toMatchObject({
      title: "Updated",
      notes: "Notes",
      tags: ["home", "work"],
    });
  });

  it("disables, archives, and restores a reminder", () => {
    const reminder = createReminder(base);
    expect(setReminderEnabled(reminder, false).status).toBe("disabled");
    expect(archiveReminder(reminder).status).toBe("archived");
    expect(restoreReminder(archiveReminder(reminder)).status).toBe("active");
  });

  it("duplicates with stable user content and a new identity", () => {
    const copy = duplicateReminder(
      createReminder(base),
      "reminder-2",
      base.now,
    );
    expect(copy.id).toBe("reminder-2");
    expect(copy.title).toBe(base.title);
    expect(copy.revision).toBe(1);
  });

  it("completes the whole reminder separately from its occurrences and reopens explicitly", () => {
    const reminder = createReminder(base);
    const now = "2026-09-24T12:00:00.000Z";
    const completed = completeReminder(reminder, now);
    expect(completed).toMatchObject({
      status: "completed",
      revision: reminder.revision + 1,
      updatedAt: now,
      schedule: reminder.schedule,
    });
    expect(reminder.status).toBe("active");
    expect(completeReminder(completed, now)).toBe(completed);
    expect(() => setReminderEnabled(completed, true)).toThrow("Reopen");
    expect(restoreReminder(completed, now).status).toBe("active");
    expect(
      completeReminder(setReminderEnabled(reminder, false), now).status,
    ).toBe("completed");
    expect(() => completeReminder(archiveReminder(reminder), now)).toThrow(
      "Restore",
    );
    expect(duplicateReminder(completed, "completed-copy", now).status).toBe(
      "active",
    );
  });

  it("dismisses and postpones only an occurrence", () => {
    const occurrence = {
      id: "reminder-1:2026-09-24T12:00:00.000Z",
      reminderId: "reminder-1",
      scheduledAt: "2026-09-24T12:00:00.000Z",
      status: "scheduled" as const,
    };
    expect(dismissOccurrence(occurrence, base.now).status).toBe("dismissed");
    expect(postponeOccurrence(occurrence, 10, base.now).snoozedUntil).toBe(
      "2026-09-23T12:10:00.000Z",
    );
  });

  it("completes an occurrence without changing its recurring reminder", () => {
    const reminder = createReminder(base);
    const occurrence = {
      id: "reminder-1:2026-09-24T12:00:00.000Z",
      reminderId: reminder.id,
      scheduledAt: "2026-09-24T12:00:00.000Z",
      status: "postponed" as const,
      snoozedUntil: "2026-09-24T12:10:00.000Z",
    };
    expect(completeOccurrence(occurrence, base.now)).toMatchObject({
      status: "completed",
      actedAt: base.now,
      snoozedUntil: undefined,
    });
    expect(reminder.status).toBe("active");
    expect(reminder.schedule).toEqual(base.schedule);
    expect(occurrence.status).toBe("postponed");
  });
});
