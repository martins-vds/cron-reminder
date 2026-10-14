import { describe, expect, it } from "vitest";
import { buildTaskReminderPolicy, taskCadenceMinutes } from "./taskEditor";

const input = {
  firstReminderAt: "2026-10-14T12:00:00.000Z",
  dueAt: "2026-10-14T18:00:00.000Z",
  cadenceMinutes: 30,
  timezone: "UTC",
  from: "2026-10-13T12:00:00.000Z",
};

describe("task editor reminder policy", () => {
  it("requires an overdue continuation for a one-time first reminder", () => {
    const policy = buildTaskReminderPolicy({ ...input, kind: "once" });
    expect(policy).toEqual({
      primary: { kind: "once", at: input.firstReminderAt },
      overdue: {
        kind: "cron",
        expression: "*/30 * * * *",
        startAt: input.dueAt,
      },
    });
    expect(taskCadenceMinutes(policy)).toBe("30");
  });

  it("keeps a recurring primary policy as the continuation", () => {
    const policy = buildTaskReminderPolicy({ ...input, kind: "recurring" });
    expect(policy).toEqual({
      primary: {
        kind: "cron",
        expression: "*/30 * * * *",
        startAt: input.firstReminderAt,
      },
    });
    expect(taskCadenceMinutes(policy)).toBe("30");
  });

  it("rejects a first reminder after the due date", () => {
    expect(() =>
      buildTaskReminderPolicy({
        ...input,
        kind: "once",
        firstReminderAt: "2026-10-14T19:00:00.000Z",
      }),
    ).toThrow("on or before");
  });
});
