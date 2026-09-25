import { describe, expect, it } from "vitest";
import {
  buildCronExpression,
  createScheduleEditorState,
  hasValidScheduleEditorValues,
} from "./scheduleEditor";

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
  });
});
