import { describe, expect, it } from "vitest";
import {
  localAnalyticsDay,
  summarizeAnalytics,
  type AnalyticsSnapshot,
} from "../src/index";

const snapshot: AnalyticsSnapshot = {
  availableSince: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-10-09T12:00:00Z",
  days: [
    {
      reminderId: "work",
      day: "2026-10-09",
      timezone: "UTC",
      completed: 1,
      postponed: 3,
    },
    {
      reminderId: "work",
      day: "2026-10-03",
      timezone: "UTC",
      completed: 2,
      postponed: 0,
    },
    {
      reminderId: "home",
      day: "2026-09-30",
      timezone: "America/Sao_Paulo",
      completed: 4,
      postponed: 2,
    },
    {
      reminderId: "work",
      day: "2026-01-01",
      timezone: "UTC",
      completed: 5,
      postponed: 1,
    },
  ],
};

describe("habit analytics", () => {
  it("counts repeated postponements and includes today in seven calendar days", () => {
    const result = summarizeAnalytics(
      snapshot,
      "7",
      new Date("2026-10-09T12:00:00Z"),
    );
    expect(result.totals).toEqual({ completed: 3, postponed: 3 });
    expect(result.trend).toHaveLength(7);
    expect(result.trend[0]?.day).toBe("2026-10-03");
    expect(result.reminders).toEqual([
      { reminderId: "work", completed: 3, postponed: 3 },
    ]);
  });
  it("weekly and monthly grouping preserve totals", () => {
    expect(
      summarizeAnalytics(snapshot, "90", new Date(snapshot.fetchedAt)).totals,
    ).toEqual({ completed: 7, postponed: 5 });
    const all = summarizeAnalytics(
      snapshot,
      "all",
      new Date(snapshot.fetchedAt),
    );
    expect(all.totals).toEqual({ completed: 12, postponed: 6 });
    expect(all.trend.reduce((sum, row) => sum + row.completed, 0)).toBe(12);
    expect(all.trend.reduce((sum, row) => sum + row.postponed, 0)).toBe(6);
    expect(all.trend.at(-1)).toMatchObject({
      day: "2026-10-01",
      completed: 3,
      postponed: 3,
    });
  });
  it("uses reminder-local calendar dates across midnight and DST", () => {
    expect(
      localAnalyticsDay(new Date("2026-10-09T00:30:00Z"), "America/Sao_Paulo"),
    ).toBe("2026-10-08");
    expect(
      localAnalyticsDay(new Date("2026-03-08T07:00:00Z"), "America/New_York"),
    ).toBe("2026-03-08");
    const result = summarizeAnalytics(
      snapshot,
      "7",
      new Date("2026-10-09T00:30:00Z"),
    );
    expect(result.totals).toEqual({ completed: 3, postponed: 3 });
  });
  it("does not fill days before available coverage or add future activity", () => {
    const result = summarizeAnalytics(
      {
        ...snapshot,
        availableSince: "2026-10-08T00:00:00Z",
        days: [
          ...snapshot.days.slice(0, 1),
          { ...snapshot.days[0]!, day: "2026-10-10", completed: 100 },
        ],
      },
      "30",
      new Date(snapshot.fetchedAt),
    );
    expect(result.trend.map((row) => row.day)).toEqual([
      "2026-10-08",
      "2026-10-09",
    ]);
    expect(result.totals).toEqual({ completed: 1, postponed: 3 });
  });
});
