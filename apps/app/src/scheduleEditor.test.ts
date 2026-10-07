import { describe, expect, it } from "vitest";
import {
  buildCronExpression,
  buildSchedule,
  createScheduleEditorState,
  hasValidScheduleEditorValues,
} from "./scheduleEditor";
import { MAX_DAILY_TIMES } from "@cron-reminder/domain";

describe("schedule editor", () => {
  it.each([
    "0 9 * * *",
    "*/5 * * * *",
    "0 9 * * 1-5",
    "0 9 20 * *",
    "0 9 24 9 *",
  ])(
    "round-trips bounded preset %s without forcing advanced mode",
    (expression) => {
      const schedule = {
        kind: "cron" as const,
        expression,
        startAt: "2026-09-24T00:00:00.000Z",
        endAt: "2026-10-24T00:00:00.000Z",
        occurrenceLimit: 12,
      };
      const editor = createScheduleEditorState(schedule);
      expect(editor.kind).not.toBe("advanced");
      expect(editor.ends).toBe("until-or-count");
      expect(buildSchedule(editor)).toEqual({
        ...schedule,
        expression: buildCronExpression(editor),
      });
    },
  );

  it("preserves bounded daily times across edits and frequency changes", () => {
    const schedule = {
      kind: "daily-times" as const,
      times: ["09:00", "12:30"],
      endAt: "2026-10-24T00:00:00.000Z",
    };
    const editor = createScheduleEditorState(schedule);
    expect(editor).toMatchObject({
      kind: "daily",
      ends: "until",
      endAt: schedule.endAt,
    });
    expect(buildSchedule(editor)).toEqual(schedule);
    expect(buildSchedule({ ...editor, kind: "weekdays" })).toMatchObject({
      kind: "cron",
      endAt: schedule.endAt,
    });
    expect(
      buildSchedule({ ...editor, ends: "count", occurrenceLimit: "7" }),
    ).toEqual({
      kind: "daily-times",
      times: schedule.times,
      occurrenceLimit: 7,
    });
    expect(buildSchedule({ ...editor, ends: "never" })).toEqual({
      kind: "daily-times",
      times: schedule.times,
    });
    expect(buildSchedule({ ...editor, kind: "once" })).toEqual({
      kind: "once",
      at: editor.onceAt,
    });
  });

  it("validates end dates and positive safe whole occurrence counts", () => {
    const state = createScheduleEditorState(undefined);
    for (const occurrenceLimit of [
      "",
      "0",
      "-1",
      "1.5",
      "NaN",
      "9007199254740992",
    ]) {
      expect(
        hasValidScheduleEditorValues({
          ...state,
          ends: "count",
          occurrenceLimit,
        }),
      ).toBe(false);
    }
    expect(
      hasValidScheduleEditorValues({
        ...state,
        ends: "count",
        occurrenceLimit: "3",
      }),
    ).toBe(true);
    expect(
      hasValidScheduleEditorValues({ ...state, ends: "until", endAt: "" }),
    ).toBe(false);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        ends: "until",
        endAt: "2026-02-30T09:00:00Z",
      }),
    ).toBe(false);
    expect(
      hasValidScheduleEditorValues({
        ...state,
        ends: "never",
        endAt: "",
        occurrenceLimit: "",
      }),
    ).toBe(true);
  });

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
