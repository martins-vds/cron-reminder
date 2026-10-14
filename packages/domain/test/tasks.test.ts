import { describe, expect, it } from "vitest";
import {
  archiveTask,
  calculateTaskReminderOccurrences,
  completeTask,
  completeTaskOccurrence,
  createTask,
  createTaskOccurrence,
  dismissTaskOccurrence,
  postponeTaskOccurrence,
  restoreTask,
  updateTask,
  type TaskReminderPolicy,
} from "../src/index";

const base = {
  id: "task-1",
  ownerId: "user-1",
  title: "Submit report",
  dueAt: "2026-10-15T17:00:00.000Z",
  reminderPolicy: {
    primary: { kind: "once" as const, at: "2026-10-15T16:00:00.000Z" },
    overdue: { kind: "cron" as const, expression: "0 * * * *" },
  },
  timezone: "UTC",
  now: "2026-10-13T12:00:00.000Z",
};

describe("task lifecycle", () => {
  it("creates, normalizes, updates, completes, archives, and restores tasks", () => {
    const task = createTask({
      ...base,
      title: "  Submit report ",
      tags: [" work ", "work"],
    });
    expect(task).toMatchObject({
      title: "Submit report",
      tags: ["work"],
      status: "open",
      revision: 1,
    });
    expect(
      updateTask(task, { notes: "  Include appendix " }, base.now),
    ).toMatchObject({ notes: "Include appendix", revision: 2 });
    expect(completeTask(task, base.now).status).toBe("completed");
    expect(() => completeTask(archiveTask(task), base.now)).toThrow("Restore");
    expect(restoreTask(archiveTask(task), base.now).status).toBe("open");
  });

  it("requires an overdue cadence for one-time primary reminders", () => {
    expect(() =>
      createTask({
        ...base,
        reminderPolicy: {
          primary: base.reminderPolicy.primary,
        } as TaskReminderPolicy,
      }),
    ).toThrow("overdue");
    expect(() =>
      createTask({
        ...base,
        reminderPolicy: {
          ...base.reminderPolicy,
          overdue: { kind: "once", at: base.dueAt } as never,
        },
      }),
    ).toThrow("recurring");
  });

  it("requires the first calculated reminder on or before the due date", () => {
    expect(() =>
      createTask({
        ...base,
        reminderPolicy: {
          ...base.reminderPolicy,
          primary: { kind: "once", at: "2026-10-15T18:00:00.000Z" },
        },
      }),
    ).toThrow("on or before");
    expect(() =>
      createTask({
        ...base,
        reminderPolicy: {
          primary: {
            kind: "cron",
            expression: "0 18 * * *",
            startAt: "2026-10-15T18:00:00.000Z",
          },
        },
      }),
    ).toThrow("on or before");
  });

  it("allows recurring task edits after due when its original first reminder met the deadline", () => {
    const task = createTask({
      ...base,
      reminderPolicy: {
        primary: { kind: "cron", expression: "0 16 * * *" },
      },
    });
    expect(
      updateTask(
        task,
        { title: "Updated overdue task" },
        "2026-10-20T12:00:00.000Z",
      ).title,
    ).toBe("Updated overdue task");
  });
});

describe("task reminder occurrences", () => {
  it("switches a one-time primary to overdue cadence strictly after due", () => {
    const task = createTask(base);
    expect(
      calculateTaskReminderOccurrences(
        task,
        new Date("2026-10-15T15:00:00.000Z"),
        4,
      ),
    ).toEqual([
      {
        scheduledAt: "2026-10-15T16:00:00.000Z",
        source: "primary",
      },
      {
        scheduledAt: "2026-10-15T18:00:00.000Z",
        source: "overdue",
      },
      {
        scheduledAt: "2026-10-15T19:00:00.000Z",
        source: "overdue",
      },
      {
        scheduledAt: "2026-10-15T20:00:00.000Z",
        source: "overdue",
      },
    ]);
  });

  it("keeps recurring primary reminders running after due", () => {
    const task = createTask({
      ...base,
      reminderPolicy: {
        primary: { kind: "cron", expression: "0 16 * * *" },
      },
    });
    expect(
      calculateTaskReminderOccurrences(
        task,
        new Date("2026-10-15T17:00:00.000Z"),
        2,
      ).map(({ scheduledAt, source }) => ({ scheduledAt, source })),
    ).toEqual([
      {
        scheduledAt: "2026-10-16T16:00:00.000Z",
        source: "primary",
      },
      {
        scheduledAt: "2026-10-17T16:00:00.000Z",
        source: "primary",
      },
    ]);
    expect(
      calculateTaskReminderOccurrences(completeTask(task), new Date(base.now)),
    ).toEqual([]);
  });

  it("supports dismiss, postpone, and complete occurrence actions", () => {
    const occurrence = createTaskOccurrence("task-1", {
      scheduledAt: "2026-10-15T16:00:00.000Z",
      source: "primary",
    });
    expect(dismissTaskOccurrence(occurrence, base.now).status).toBe(
      "dismissed",
    );
    expect(postponeTaskOccurrence(occurrence, 10, base.now).snoozedUntil).toBe(
      "2026-10-13T12:10:00.000Z",
    );
    expect(
      completeTaskOccurrence(
        { ...occurrence, status: "postponed", snoozedUntil: base.dueAt },
        base.now,
      ),
    ).toMatchObject({ status: "completed", snoozedUntil: undefined });
  });
});
