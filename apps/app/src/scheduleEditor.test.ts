import { describe, expect, it } from "vitest";
import {
  buildCronExpression,
  createScheduleEditorState,
  hasValidScheduleEditorValues,
} from "./scheduleEditor";
import { MAX_DAILY_TIMES } from "@cron-reminder/domain";

describe("schedule editor", () => {
  it("turns common cron expressions into plain-language editor modes", () => {
    expect(
      createScheduleEditorState({
        kind: "cron",
        expression: "30 8 * * 1-5",
      }),
    ).toMatchObject({ kind: "weekdays", time: "08:30" });
    expect(
      createScheduleEditorState({
        kind: "cron",
        expression: "15 10 20 * *",
      }),
    ).toMatchObject({ kind: "monthly", monthDay: "20", time: "10:15" });
    expect(
      createScheduleEditorState({
        kind: "cron",
        expression: "0 9 24 9 *",
      }),
    ).toMatchObject({
      kind: "yearly",
      yearMonth: "9",
      yearDay: "24",
      time: "09:00",
    });
    expect(
      createScheduleEditorState({
        kind: "cron",
        expression: "0 9,12,18,21 * * *",
      }),
    ).toMatchObject({
      kind: "daily",
      dailyTimes: ["09:00", "12:00", "18:00", "21:00"],
    });
  });

  it("keeps unsupported expressions in advanced mode", () => {
    expect(
      createScheduleEditorState({
        kind: "cron",
        expression: "0 9 * * MON,WED,FRI",
      }),
    ).toMatchObject({
      kind: "advanced",
      advancedCron: "0 9 * * MON,WED,FRI",
    });
  });

  it("opens daily-times schedules under the daily frequency", () => {
    expect(
      createScheduleEditorState({
        kind: "daily-times",
        times: ["08:00", "12:30", "17:45"],
      }),
    ).toMatchObject({
      kind: "daily",
      dailyTimes: ["08:00", "12:30", "17:45"],
    });
  });

  it("builds cron internally from preset-specific values", () => {
    const state = createScheduleEditorState(undefined);
    expect(
      buildCronExpression({
        ...state,
        kind: "monthly",
        monthDay: "20",
        time: "8:30",
      }),
    ).toBe("30 08 20 * *");
    expect(
      buildCronExpression({
        ...state,
        kind: "yearly",
        yearMonth: "9",
        yearDay: "24",
        time: "09:15",
      }),
    ).toBe("15 09 24 9 *");
  });

  it("rejects invalid preset values before saving", () => {
    const state = createScheduleEditorState(undefined);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        kind: "interval",
        intervalMinutes: "60",
      }),
    ).toBe(false);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        kind: "yearly",
        yearMonth: "2",
        yearDay: "30",
      }),
    ).toBe(false);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        kind: "daily",
        dailyTimes: ["09:15", "12:30"],
      }),
    ).toBe(true);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        kind: "daily",
        dailyTimes: ["09:00", "09:00"],
      }),
    ).toBe(false);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        kind: "daily",
        dailyTimes: Array.from(
          { length: MAX_DAILY_TIMES + 1 },
          (_value, index) =>
            `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
        ),
      }),
    ).toBe(false);
  });

  it("supports one or more daily times through the daily frequency", () => {
    const state = createScheduleEditorState(undefined);
    expect(
      buildCronExpression({
        ...state,
        kind: "daily",
        dailyTimes: ["07:45"],
      }),
    ).toBe("45 07 * * *");
    expect(
      hasValidScheduleEditorValues({
        ...state,
        kind: "daily",
        dailyTimes: ["07:45"],
      }),
    ).toBe(true);
  });
});
