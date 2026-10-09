import type { AnalyticsSnapshot, DailyAnalytics } from "@cron-reminder/domain";
import type { DatabaseClient } from "./databaseClient";
import type { AnalyticsRepository } from "@cron-reminder/application";

export class SupabaseAnalyticsRepository implements AnalyticsRepository {
  constructor(private readonly client: DatabaseClient) {}
  async load(ownerId: string): Promise<AnalyticsSnapshot> {
    const initialized = await this.client.rpc("initialize_analytics");
    if (initialized.error) throw initialized.error;
    const { data: rows, error } = await this.client.readPage(
      "analytics_coverage",
      ownerId,
      ["owner_id"],
      0,
      1,
    );
    const coverage = rows?.[0];
    if (error) throw error;
    if (!coverage || typeof coverage.available_since !== "string")
      throw new Error("Analytics coverage is unavailable.");
    const days: DailyAnalytics[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.client.readPage(
        "reminder_daily_analytics",
        ownerId,
        ["reminder_id", "local_day", "timezone"],
        offset,
        1000,
      );
      if (page.error) throw page.error;
      for (const row of page.data ?? []) {
        const completed = Number(row.completed);
        const postponed = Number(row.postponed);
        if (
          typeof row.reminder_id !== "string" ||
          typeof row.local_day !== "string" ||
          typeof row.timezone !== "string"
        )
          throw new Error("Analytics dates are invalid.");
        if (
          !Number.isSafeInteger(completed) ||
          completed < 0 ||
          !Number.isSafeInteger(postponed) ||
          postponed < 0
        )
          throw new Error("Analytics counts are invalid.");
        days.push({
          reminderId: row.reminder_id,
          day: row.local_day,
          timezone: row.timezone,
          completed,
          postponed,
        });
      }
      if ((page.data?.length ?? 0) < 1000) break;
    }
    return {
      days,
      availableSince: new Date(coverage.available_since).toISOString(),
      fetchedAt: new Date().toISOString(),
    };
  }
}
