import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  nextOccurrences,
  parseCronSchedule,
  validateCronExpression,
  validateSchedule,
} from "../src/index";

describe("cron schedule", () => {
  it("accepts standard five-field cron and rejects seconds", () => {
    expect(validateCronExpression("*/5 * * * *")).toEqual({ valid: true });
    expect(validateCronExpression("* * * * * *").valid).toBe(false);
  });

  it("rejects cron syntax unsupported by database validation", () => {
    expect(validateCronExpression("0 9 L * *").valid).toBe(false);
    expect(validateCronExpression("0 9 * * 1#2").valid).toBe(false);
    expect(validateCronExpression("0 9 * JAN MON-FRI").valid).toBe(true);
  });

  it("enforces a minimum one-minute interval", () => {
    expect(validateCronExpression("* * * * *")).toEqual({ valid: true });
  });

  it("previews five timezone-aware occurrences", () => {
    const occurrences = nextOccurrences(
      parseCronSchedule("0 9 * * 1-5"),
      "America/Sao_Paulo",
      new Date("2026-09-23T12:01:00.000Z"),
      5,
    );
    expect(occurrences).toHaveLength(5);
    expect(occurrences[0]?.toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });

  it("describes common schedules in English and Brazilian Portuguese", () => {
    expect(
      describeSchedule({ kind: "cron", expression: "0 9 * * *" }, "en"),
    ).toBe("Every day at 09:00");
    expect(
      describeSchedule({ kind: "cron", expression: "0 9 * * *" }, "pt-BR"),
    ).toBe("Todos os dias às 09:00");
  });

  it("moves a nonexistent daylight-saving time to the next valid time", () => {
    const [occurrence] = nextOccurrences(
      parseCronSchedule("30 2 * * *"),
      "America/New_York",
      new Date("2026-03-08T05:00:00.000Z"),
      1,
    );
    expect(occurrence?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("emits a repeated daylight-saving local time only once", () => {
    const occurrences = nextOccurrences(
      parseCronSchedule("30 1 * * *"),
      "America/New_York",
      new Date("2026-11-01T04:00:00.000Z"),
      2,
    );
    expect(occurrences.map((value) => value.toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("rejects invalid start and end bounds instead of silently passing", () => {
    expect(() =>
      validateSchedule({
        kind: "cron",
        expression: "0 9 * * *",
        startAt: "not-a-date",
      }),
    ).toThrow("Schedule start must be a valid date.");
    expect(() =>
      validateSchedule({
        kind: "cron",
        expression: "0 9 * * *",
        endAt: "not-a-date",
      }),
    ).toThrow("Schedule end must be a valid date.");
  });

  it("requires a positive integer occurrence limit", () => {
    expect(() =>
      validateSchedule({
        kind: "cron",
        expression: "0 9 * * *",
        occurrenceLimit: 1.5,
      }),
    ).toThrow("positive integer");
    expect(() =>
      validateSchedule({
        kind: "cron",
        expression: "0 9 * * *",
        occurrenceLimit: Number.NaN,
      }),
    ).toThrow("positive integer");
  });
});
