import { describe, expect, it } from "vitest";
import { buildTaskReminderPolicy } from "./taskEditor";

const input = {
  dueAt: "2026-10-14T18:00:00.000Z",
  timezone: "UTC",
  from: "2026-10-13T12:00:00.000Z",
};

describe("task editor reminder policy", () => {
  it("requires an overdue continuation for a one-time first reminder", () => {
    const policy = buildTaskReminderPolicy({
      ...input,
      primary: { kind: "once", at: "2026-10-14T12:00:00.000Z" },
      overdue: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        startAt: input.dueAt,
      },
    });
    expect(policy).toEqual({
      primary: { kind: "once", at: "2026-10-14T12:00:00.000Z" },
      overdue: {
        kind: "cron",
        expression: "0 9 * * 1-5",
      },
    });
  });

  it.each([
    { kind: "cron" as const, expression: "*/30 * * * *" },
    { kind: "cron" as const, expression: "0 9 * * *" },
    { kind: "cron" as const, expression: "0 9 * * 1-5" },
    { kind: "cron" as const, expression: "0 9 1 * *" },
    { kind: "cron" as const, expression: "0 9 1 1 *" },
    { kind: "daily-times" as const, times: ["09:00", "17:00"] },
  ])("keeps the $kind recurring primary policy", (primary) => {
    const policy = buildTaskReminderPolicy({
      ...input,
      dueAt: "2027-10-14T18:00:00.000Z",
      primary,
    });
    expect(policy).toEqual({
      primary,
    });
  });

  it("rejects a first reminder after the due date", () => {
    expect(() =>
      buildTaskReminderPolicy({
        ...input,
        primary: { kind: "once", at: "2026-10-14T19:00:00.000Z" },
        overdue: { kind: "cron", expression: "0 9 * * *" },
      }),
    ).toThrow("on or before");
  });

  it("rejects a one-time overdue schedule", () => {
    expect(() =>
      buildTaskReminderPolicy({
        ...input,
        primary: { kind: "once", at: "2026-10-14T12:00:00.000Z" },
        overdue: { kind: "once", at: "2026-10-15T12:00:00.000Z" },
      }),
    ).toThrow("recurring overdue schedule");
  });
});
