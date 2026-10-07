import { describe, expect, it } from "vitest";
import {
  nextPostponementAt,
  resolvePostponement,
  type Reminder,
  type Schedule,
} from "../src/index";

const now = "2026-10-07T12:00:00.000Z";
const next = "2026-10-07T13:00:00.000Z";
const reminder = (
  schedule: Schedule,
): Pick<Reminder, "schedule" | "timezone" | "status"> => ({
  schedule,
  timezone: "UTC",
  status: "active",
});

describe("bounded postponement", () => {
  it.each([5, 10, 15])("supports the %i-minute preset", (minutes) => {
    expect(resolvePostponement(minutes, now, next)).toEqual({
      until: new Date(Date.parse(now) + minutes * 60_000).toISOString(),
      mergeIntoNext: false,
    });
  });

  it("includes the next occurrence and merges exact custom and next choices", () => {
    expect(resolvePostponement(60, now, next)).toEqual({
      until: next,
      mergeIntoNext: true,
    });
    expect(resolvePostponement("next", now, next)).toEqual({
      until: next,
      mergeIntoNext: true,
    });
    expect(resolvePostponement({ until: next }, now, next)).toEqual({
      until: next,
      mergeIntoNext: true,
    });
  });

  it("rejects times after the next occurrence, including one millisecond over", () => {
    expect(() => resolvePostponement(75, now, next)).toThrow("no later");
    expect(() =>
      resolvePostponement({ until: "2026-10-07T13:00:00.001Z" }, now, next),
    ).toThrow("no later");
    expect(() =>
      resolvePostponement(5, "2026-10-07T12:56:00.000Z", next),
    ).toThrow("no later");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid custom duration %s",
    (minutes) => {
      expect(() => resolvePostponement(minutes, now, null)).toThrow();
    },
  );

  it("allows more than an hour when no future occurrence exists", () => {
    expect(resolvePostponement(75, now, null)).toEqual({
      until: "2026-10-07T13:15:00.000Z",
      mergeIntoNext: false,
    });
    expect(() => resolvePostponement("next", now, null)).toThrow("no next");
  });

  it("rejects expired choices instead of silently moving them forward", () => {
    expect(() => resolvePostponement({ until: now }, now, next)).toThrow(
      "has passed",
    );
    expect(() => resolvePostponement(5, next, next)).toThrow("has changed");
    expect(() => resolvePostponement({ until: "invalid" }, now, next)).toThrow(
      "valid",
    );
  });

  it("uses the next future schedule for overdue reminders", () => {
    expect(
      nextPostponementAt(
        reminder({ kind: "cron", expression: "0 * * * *" }),
        new Date("2026-10-07T12:10:00.000Z"),
      ),
    ).toBe(next);
  });

  it("respects the reminder timezone and multiple daily times", () => {
    expect(
      nextPostponementAt(
        {
          ...reminder({ kind: "daily-times", times: ["09:00", "15:00"] }),
          timezone: "America/Sao_Paulo",
        },
        new Date("2026-10-07T11:55:00.000Z"),
      ),
    ).toBe(now);
  });

  it("uses the DST-adjusted future boundary", () => {
    expect(
      nextPostponementAt(
        {
          ...reminder({ kind: "cron", expression: "0 * * * *" }),
          timezone: "America/New_York",
        },
        new Date("2026-03-08T06:55:00.000Z"),
      ),
    ).toBe("2026-03-08T07:00:00.000Z");
  });

  it("has no boundary for a past one-time or exhausted recurring schedule", () => {
    expect(
      nextPostponementAt(reminder({ kind: "once", at: now }), new Date(now)),
    ).toBeNull();
    expect(
      nextPostponementAt(
        reminder({
          kind: "cron",
          expression: "0 * * * *",
          occurrenceLimit: 2,
        }),
        new Date(now),
        2,
      ),
    ).toBeNull();
    expect(
      nextPostponementAt(
        reminder({
          kind: "cron",
          expression: "0 * * * *",
          endAt: now,
        }),
        new Date(next),
      ),
    ).toBeNull();
  });
});
