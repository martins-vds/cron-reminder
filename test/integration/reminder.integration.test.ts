import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextPostponementAt, type Schedule } from "@cron-reminder/domain";

const { Pool } = pg;
const ownerId = "11111111-1111-4111-8111-111111111111";
const jwtSecret =
  process.env.INTEGRATION_JWT_SECRET ??
  "integration-jwt-secret-at-least-32-characters";
const pool = new Pool({
  connectionString:
    process.env.INTEGRATION_DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:55430/postgres",
});

function jwt(role: string, sub?: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    exp: 4_102_444_800,
    iat: 1_700_000_000,
    iss: "supabase",
    role,
    ...(sub ? { sub } : {}),
  });
  const signature = crypto
    .createHmac("sha256", jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function insertOwner(): Promise<void> {
  await pool.query("insert into auth.users(id, email) values ($1, $2)", [
    ownerId,
    "integration@example.com",
  ]);
}

async function insertReminder(options?: {
  id?: string;
  occurrenceLimit?: number;
  schedule?: Record<string, unknown>;
  scheduleRevision?: number;
  scheduledAt?: Date;
}): Promise<{ id: string; scheduledAt: Date }> {
  const id = options?.id ?? "integration-reminder";
  const scheduledAt = options?.scheduledAt ?? new Date(Date.now() - 5_000);
  const schedule =
    options?.schedule ??
    (options?.occurrenceLimit
      ? {
          kind: "cron",
          expression: "* * * * *",
          occurrenceLimit: options.occurrenceLimit,
        }
      : { kind: "once", at: scheduledAt.toISOString() });
  await pool.query(
    `insert into public.reminders(
      id, owner_id, title, schedule, timezone, sound, revision,
      schedule_revision, next_due_at, created_at, updated_at
    ) values ($1, $2, 'Integration reminder', $3, 'UTC',
      '{"mode":"default"}', 1, $4, $5, $6, $6)`,
    [
      id,
      ownerId,
      JSON.stringify(schedule),
      options?.scheduleRevision ?? 1,
      scheduledAt.toISOString(),
      new Date(scheduledAt.getTime() - 60_000).toISOString(),
    ],
  );
  return { id, scheduledAt };
}

async function insertPostponementOccurrence(
  schedule: Schedule,
): Promise<string> {
  const { id, scheduledAt } = await insertReminder({ schedule });
  const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
  await pool.query(
    `insert into public.occurrences(
      id, reminder_id, owner_id, reminder_revision, scheduled_at, status
    ) values ($1, $2, $3, 1, $4, 'triggered')`,
    [occurrenceId, id, ownerId, scheduledAt.toISOString()],
  );
  return occurrenceId;
}

async function postponeRequest(
  occurrenceId: string,
  selection: { minutes: number } | { until: string },
) {
  return fetch("http://127.0.0.1:55431/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ occurrenceId, action: "snooze", ...selection }),
  });
}

async function resetDatabase(): Promise<void> {
  await pool.query("truncate table auth.users cascade");
  await pool.query(
    `update public.dispatch_state
     set last_dispatched_at = now() - interval '1 minute',
         last_dispatched_owner_id = null,
         last_dispatched_reminder_id = null
     where id = true`,
  );
}

beforeAll(async () => {
  await pool.query("select 1");
});

beforeEach(async () => {
  await resetDatabase();
  await insertOwner();
});

afterAll(async () => {
  await pool.end();
});

async function authenticatedRequest(
  path: string,
  body?: unknown,
  account = ownerId,
): Promise<Response> {
  return fetch(`http://127.0.0.1:55421/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${jwt("authenticated", account)}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("categories and durable habit analytics", () => {
  it.each(["all", "uncategorized"])(
    "rejects the reserved category identifier %s",
    async (id) => {
      const response = await authenticatedRequest("rpc/save_category", {
        p_id: id,
        p_name: "Fitness",
        p_revision: 1,
        p_expected_revision: null,
        p_deleted: false,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("23514");
    },
  );
  it("initializes categories once, atomically removes assignments, and preserves scheduler fields", async () => {
    expect(
      (
        await authenticatedRequest("rpc/initialize_categories", {
          p_portuguese: false,
        })
      ).status,
    ).toBe(204);
    const { id } = await insertReminder({
      schedule: { kind: "cron", expression: "* * * * *" },
    });
    await pool.query(
      "update public.reminders set category_id = 'work' where id = $1 and owner_id = $2",
      [id, ownerId],
    );
    const before = (
      await pool.query("select * from public.reminders where id = $1", [id])
    ).rows[0];
    const response = await authenticatedRequest("rpc/save_category", {
      p_id: "work",
      p_name: "Work",
      p_revision: 2,
      p_expected_revision: 1,
      p_deleted: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(true);
    const after = (
      await pool.query("select * from public.reminders where id = $1", [id])
    ).rows[0];
    expect(after.category_id).toBeNull();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.next_due_at).toEqual(before.next_due_at);
    expect(after.schedule_revision).toBe(before.schedule_revision);
    expect(after.occurrence_count).toBe(before.occurrence_count);
    await authenticatedRequest("rpc/initialize_categories", {
      p_portuguese: false,
    });
    expect(
      (
        await pool.query(
          "select deleted_at from public.reminder_categories where id = 'work'",
        )
      ).rows[0].deleted_at,
    ).not.toBeNull();
    const stale = await authenticatedRequest("rpc/save_category", {
      p_id: "work",
      p_name: "Office",
      p_revision: 3,
      p_expected_revision: 2,
      p_deleted: false,
    });
    expect(await stale.json()).toBe(false);
    await expect(
      pool.query(
        "update public.reminders set category_id = 'work' where id = $1",
        [id],
      ),
    ).rejects.toThrow("Category no longer exists");
  });

  it("enforces category ownership, name uniqueness, and read-only analytics", async () => {
    await authenticatedRequest("rpc/initialize_categories", {});
    const other = "22222222-2222-4222-8222-222222222222";
    await pool.query("insert into auth.users(id) values ($1)", [other]);
    expect(
      await (
        await authenticatedRequest("reminder_categories", undefined, other)
      ).json(),
    ).toEqual([]);
    const duplicate = await authenticatedRequest("rpc/save_category", {
      p_id: "duplicate",
      p_name: " work ",
      p_revision: 1,
      p_expected_revision: null,
      p_deleted: false,
    });
    expect(duplicate.status).toBe(409);
    const { id } = await insertReminder();
    await pool.query(
      "insert into public.reminders(id, owner_id, title, schedule, timezone) values ('other', $1, 'Other', $2, 'UTC')",
      [other, { kind: "once", at: new Date().toISOString() }],
    );
    await expect(
      pool.query(
        "update public.reminders set category_id = 'work' where id = 'other'",
      ),
    ).rejects.toThrow("Category no longer exists");
    const write = await authenticatedRequest("reminder_daily_analytics", {
      owner_id: ownerId,
      reminder_id: id,
      local_day: "2026-10-09",
      timezone: "UTC",
      completed: 99,
    });
    expect(write.status).toBe(403);
  });

  it("counts distinct repeated postponements once per action ID, including concurrent retries", async () => {
    const occurrenceId = await insertPostponementOccurrence({
      kind: "once",
      at: new Date(Date.now() - 60_000).toISOString(),
    });
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const action = {
      occurrenceId,
      action: "snooze",
      until,
      actionId: crypto.randomUUID(),
    };
    const post = (body: unknown) =>
      fetch("http://127.0.0.1:55431/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const results = await Promise.all([post(action), post(action)]);
    expect(results.map((item) => item.status)).toEqual([200, 200]);
    expect(
      (await post({ ...action, actionId: crypto.randomUUID() })).status,
    ).toBe(200);
    const completed = {
      occurrenceId,
      action: "complete",
      actionId: crypto.randomUUID(),
    };
    expect((await post(completed)).status).toBe(200);
    expect((await post(completed)).status).toBe(200);
    expect((await post({ ...completed, action: "dismiss" })).status).toBe(409);
    const rows = (
      await pool.query(
        "select completed, postponed from public.reminder_daily_analytics",
      )
    ).rows;
    expect(rows).toEqual([{ completed: "1", postponed: "2" }]);
    await pool.query(
      "update public.history set occurred_at = now() - interval '31 days'",
    );
    await pool.query("select public.delete_expired_history()");
    expect(
      (await pool.query("select count(*) from public.history")).rows[0].count,
    ).toBe("0");
    expect(
      (
        await pool.query(
          "select completed, postponed from public.reminder_daily_analytics",
        )
      ).rows,
    ).toEqual(rows);
    expect((await post(completed)).status).toBe(200);
    expect((await post(action)).status).toBe(200);
    expect(
      (
        await pool.query(
          "select completed, postponed from public.reminder_daily_analytics",
        )
      ).rows,
    ).toEqual(rows);
    await pool.query("delete from public.reminders");
    expect(
      (await pool.query("select count(*) from public.reminder_daily_analytics"))
        .rows[0].count,
    ).toBe("0");
    expect(
      (
        await pool.query(
          "select count(*) from public.occurrence_action_receipts",
        )
      ).rows[0].count,
    ).toBe("0");
  });

  it("backfills retained History once and groups future actions in the recorded reminder timezone", async () => {
    const occurrenceId = await insertPostponementOccurrence({
      kind: "once",
      at: new Date().toISOString(),
    });
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await connection.query(`
        drop trigger history_record_daily_analytics on public.history;
        drop function public.act_on_occurrence(text, text, integer, text, text);
        drop function public.postpone_occurrence(text, uuid, timestamptz, timestamptz, integer, bigint, text, text);
        drop function public.record_daily_analytics();
        drop function public.initialize_analytics();
        drop table public.reminder_daily_analytics, public.analytics_coverage, public.occurrence_action_receipts;
        alter function public.act_on_occurrence_without_receipt(text, text, integer) rename to act_on_occurrence;
        alter function public.postpone_occurrence_without_receipt(text, uuid, timestamptz, timestamptz, integer, bigint) rename to postpone_occurrence;
      `);
      await connection.query(
        "update public.reminders set timezone = 'America/Sao_Paulo'",
      );
      const reminderId = occurrenceId.split(":")[0];
      await connection.query(
        `insert into public.history(reminder_id, occurrence_id, owner_id, event_type, occurred_at)
        values ($1, $2, $3, 'postponed', '2026-10-09T01:00:00Z'), ($1, $2, $3, 'postponed', '2026-10-09T02:00:00Z'),
        ($1, $2, $3, 'completed', '2026-10-09T04:00:00Z'), ($1, $2, $3, 'dismissed', '2026-10-09T05:00:00Z')`,
        [reminderId, occurrenceId, ownerId],
      );
      const migration = await readFile(
        new URL(
          "../../supabase/migrations/20261009000001_habit_analytics.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await connection.query(migration.replace(/^(begin|commit);$/gm, ""));
      expect(
        (
          await connection.query(
            "select local_day::text, timezone, completed, postponed from public.reminder_daily_analytics order by local_day",
          )
        ).rows,
      ).toEqual([
        {
          local_day: "2026-10-08",
          timezone: "America/Sao_Paulo",
          completed: "0",
          postponed: "2",
        },
        {
          local_day: "2026-10-09",
          timezone: "America/Sao_Paulo",
          completed: "1",
          postponed: "0",
        },
      ]);
      await connection.query("update public.reminders set timezone = 'UTC'");
      expect(
        (
          await connection.query(
            "select distinct timezone from public.reminder_daily_analytics",
          )
        ).rows,
      ).toEqual([{ timezone: "America/Sao_Paulo" }]);
      await connection.query("delete from auth.users where id = $1", [ownerId]);
      expect(
        (
          await connection.query(
            "select count(*) from public.reminder_daily_analytics",
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      await connection.query("rollback");
      connection.release();
    }
  });
});

describe("database migrations and delivery RPCs", () => {
  it("completes an entire reminder, cancels pending work, preserves History, and reopens without old postponements", async () => {
    const { id, scheduledAt } = await insertReminder({
      schedule: { kind: "cron", expression: "* * * * *" },
    });
    const lease = crypto.randomUUID();
    const statuses = [
      "scheduled",
      "triggered",
      "delivering",
      "delivery-failed",
      "postponed",
      "missed",
      "completed",
    ];
    for (const status of statuses) {
      await pool.query(
        `insert into public.occurrences(
          id, reminder_id, owner_id, reminder_revision, scheduled_at, status,
          snoozed_until, delivery_lease_id
        ) values ($1, $2, $3, 1, $4, $5, $6, $7)`,
        [
          `${id}:${status}`,
          id,
          ownerId,
          new Date(
            scheduledAt.getTime() - statuses.indexOf(status) * 60_000,
          ).toISOString(),
          status,
          status === "postponed"
            ? new Date(Date.now() + 60_000).toISOString()
            : null,
          status === "delivering" ? lease : null,
        ],
      );
    }
    await pool.query(
      "insert into public.history(reminder_id, occurrence_id, owner_id, event_type) values ($1, $2, $3, 'triggered')",
      [id, `${id}:triggered`, ownerId],
    );
    const historyBefore = (await pool.query("select * from public.history"))
      .rows;
    const url = `http://127.0.0.1:55421/rest/v1/reminders?id=eq.${id}&owner_id=eq.${ownerId}`;
    const update = async (status: string, revision: number) => {
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status, revision, next_due_at: null }),
      });
      expect(response.status).toBe(204);
    };
    await update("completed", 2);
    const dispatched = await fetch("http://127.0.0.1:55432/", {
      method: "POST",
      headers: { "x-cron-secret": "integration-cron-secret" },
    });
    expect(dispatched.status).toBe(200);
    expect(await dispatched.json()).toMatchObject({ delivered: 0 });
    expect(
      (
        await pool.query(
          "select count(*)::integer as count from public.occurrences where reminder_id = $1 and owner_id = $2",
          [id, ownerId],
        )
      ).rows[0].count,
    ).toBe(statuses.length);
    const rows = (
      await pool.query<{
        id: string;
        status: string;
        snoozed_until: Date | null;
        delivery_lease_id: string | null;
      }>(
        "select id, status, snoozed_until, delivery_lease_id from public.occurrences order by id",
      )
    ).rows;
    for (const row of rows) {
      const originalStatus = row.id.split(":").at(-1)!;
      expect(row.status).toBe(
        originalStatus === "completed" ? originalStatus : "dismissed",
      );
      expect(row.snoozed_until).toBeNull();
      expect(row.delivery_lease_id).toBeNull();
    }
    expect((await pool.query("select * from public.history")).rows).toEqual(
      historyBefore,
    );
    expect(
      (
        await pool.query(
          "select public.renew_occurrence_delivery_lease($1, $2, $3, now()) as renewed",
          [`${id}:delivering`, ownerId, lease],
        )
      ).rows[0].renewed,
    ).toBe(false);
    expect(
      (
        await pool.query(
          "select public.complete_occurrence_delivery($1, $2, $3, now()) as completed",
          [`${id}:delivering`, ownerId, lease],
        )
      ).rows[0].completed,
    ).toBe(false);
    for (const postponed of [false, true]) {
      expect(
        (
          await pool.query(
            "select * from public.list_deliverable_occurrences(now(), now() - interval '5 minutes', 100, $1)",
            [postponed],
          )
        ).rows,
      ).toEqual([]);
    }
    expect(
      (
        await pool.query(
          "select public.prepare_occurrence_delivery($1, $2, $3, 2, $4, $5, now(), now() - interval '5 minutes') as prepared",
          [
            `${id}:future`,
            id,
            ownerId,
            new Date().toISOString(),
            crypto.randomUUID(),
          ],
        )
      ).rows[0].prepared,
    ).toBe(false);
    await update("active", 3);
    expect(
      (
        await pool.query(
          "select * from public.list_deliverable_occurrences(now(), now() - interval '5 minutes', 100, true)",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "select public.prepare_occurrence_delivery($1, $2, $3, 3, $4, $5, now(), now() - interval '5 minutes') as prepared",
          [
            `${id}:resumed`,
            id,
            ownerId,
            new Date().toISOString(),
            crypto.randomUUID(),
          ],
        )
      ).rows[0].prepared,
    ).toBe(true);
  });

  it.each(["web", "ios", "android"])(
    "preserves device opt-out across %s token refresh until explicit re-enable",
    async (platform) => {
      const revocationToken = crypto.randomUUID();
      await pool.query(
        `insert into public.devices(id, owner_id, platform, token, deregistration_token)
       values ('opt-out-device', $1, $2, 'original-token', $3), ('other-device', $1, $2, 'other-token', $3)`,
        [ownerId, platform, revocationToken],
      );
      const headers = {
        Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
        "Content-Type": "application/json",
      };
      const disable = await fetch(
        `http://127.0.0.1:55421/rest/v1/devices?id=eq.opt-out-device&owner_id=eq.${ownerId}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ enabled: false, user_disabled: true }),
        },
      );
      expect(disable.status).toBe(204);
      const claim = async (enable?: boolean) => {
        const response = await fetch(
          "http://127.0.0.1:55421/rest/v1/rpc/claim_device_token",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              p_device_id: "opt-out-device",
              p_platform: platform,
              p_token: "refreshed-token",
              p_deregistration_token: revocationToken,
              p_existing_deregistration_token: revocationToken,
              ...(enable === undefined ? {} : { p_enable: enable }),
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
      };
      const device = async () =>
        (
          await pool.query(
            "select enabled, user_disabled, token from public.devices where id = 'opt-out-device'",
          )
        ).rows[0];
      await claim();
      expect(await device()).toEqual({
        enabled: false,
        user_disabled: true,
        token: "refreshed-token",
      });
      await claim(false);
      expect(await device()).toEqual({
        enabled: false,
        user_disabled: true,
        token: "refreshed-token",
      });
      expect(
        (
          await pool.query(
            "select enabled from public.devices where id = 'other-device'",
          )
        ).rows[0].enabled,
      ).toBe(true);
      await claim(true);
      expect(await device()).toEqual({
        enabled: true,
        user_disabled: false,
        token: "refreshed-token",
      });
    },
  );

  it.each([5, 10, 15, 75])(
    "allows %i minutes for a one-time reminder with no next occurrence",
    async (minutes) => {
      const occurrenceId = await insertPostponementOccurrence({
        kind: "once",
        at: new Date(Date.now() - 60_000).toISOString(),
      });
      const before = Date.now();
      const response = await postponeRequest(occurrenceId, { minutes });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        until: string;
        mergedIntoNext: boolean;
      };
      expect(Date.parse(result.until)).toBeGreaterThanOrEqual(
        before + minutes * 60_000,
      );
      expect(result.mergedIntoNext).toBe(false);
    },
  );

  it("enforces the inclusive schedule boundary and permits only one delivery at the next occurrence", async () => {
    const schedule: Schedule = { kind: "cron", expression: "0 0 * * *" };
    const occurrenceId = await insertPostponementOccurrence(schedule);
    const next = nextPostponementAt(
      { schedule, timezone: "UTC", status: "active" },
      new Date(),
    )!;
    const over = await postponeRequest(occurrenceId, {
      until: new Date(Date.parse(next) + 1).toISOString(),
    });
    expect(over.status).toBe(400);
    const exact = await postponeRequest(occurrenceId, { until: next });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({
      mergedIntoNext: true,
      until: next,
    });
    const folded = await pool.query<{ postponed_to_next: boolean }>(
      "select postponed_to_next from public.occurrences where id = $1",
      [occurrenceId],
    );
    expect(folded.rows[0]?.postponed_to_next).toBe(true);
    const naturalId = `integration-reminder:${next}`;
    await pool.query(
      `insert into public.occurrences(
        id, reminder_id, owner_id, reminder_revision, scheduled_at, status
      ) values ($1, 'integration-reminder', $2, 1, $3, 'triggered')`,
      [naturalId, ownerId, next],
    );
    const postponed = await pool.query(
      "select * from public.list_deliverable_occurrences($1, $1::timestamptz - interval '5 minutes', 100, true)",
      [next],
    );
    expect(postponed.rows).toEqual([]);
    const pending = await pool.query<{ occurrence_id: string }>(
      "select * from public.list_deliverable_occurrences($1, $1::timestamptz - interval '5 minutes', 100, false)",
      [next],
    );
    expect(pending.rows.map(({ occurrence_id }) => occurrence_id)).toEqual([
      naturalId,
    ]);
    const claim = (id: string) =>
      pool.query<{ claimed: boolean }>(
        "select public.claim_occurrence_delivery($1, $2, 'integration-reminder', 1, $3, $4, $4::timestamptz - interval '5 minutes') as claimed",
        [id, ownerId, crypto.randomUUID(), next],
      );
    expect((await claim(occurrenceId)).rows[0]?.claimed).toBe(false);
    expect((await claim(naturalId)).rows[0]?.claimed).toBe(true);
  });

  it("keeps a custom postponement before the next occurrence independently deliverable", async () => {
    const schedule: Schedule = { kind: "cron", expression: "0 0 * * *" };
    const occurrenceId = await insertPostponementOccurrence(schedule);
    const until = new Date(Date.now() + 2 * 60_000).toISOString();
    expect((await postponeRequest(occurrenceId, { until })).status).toBe(200);
    const deliverable = await pool.query<{ occurrence_id: string }>(
      "select * from public.list_deliverable_occurrences($1, $1::timestamptz - interval '5 minutes', 100, true)",
      [until],
    );
    expect(deliverable.rows.map(({ occurrence_id }) => occurrence_id)).toEqual([
      occurrenceId,
    ]);
  });

  it("allows an arbitrary custom duration when the repeat limit has been reached", async () => {
    const occurrenceId = await insertPostponementOccurrence({
      kind: "cron",
      expression: "0 * * * *",
      occurrenceLimit: 1,
    });
    const response = await postponeRequest(occurrenceId, { minutes: 75 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mergedIntoNext: false });
  });

  it("retains a long one-time postponement past the normal agenda lookback", async () => {
    const scheduledAt = new Date(Date.now() - 31 * 86_400_000);
    const { id } = await insertReminder({
      scheduledAt,
      schedule: { kind: "once", at: scheduledAt.toISOString() },
    });
    const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
    await pool.query(
      `insert into public.occurrences(
          id, reminder_id, owner_id, reminder_revision, scheduled_at, created_at, status
        ) values ($1, $2, $3, 1, $4, $4, 'missed')`,
      [occurrenceId, id, ownerId, scheduledAt.toISOString()],
    );
    const until = new Date(Date.now() + 75 * 86_400_000).toISOString();
    expect((await postponeRequest(occurrenceId, { until })).status).toBe(200);
    await pool.query("select public.delete_expired_history()");
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const url = new URL("http://127.0.0.1:55421/rest/v1/occurrences");
    url.searchParams.set("select", "id");
    url.searchParams.set(
      "or",
      `(scheduled_at.gte.${cutoff},and(status.eq.postponed,postponed_to_next.eq.false),snoozed_until.gte.${cutoff})`,
    );
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt("authenticated", ownerId)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: occurrenceId }]);
  });

  it("rejects expired absolute times and invalid custom durations", async () => {
    const occurrenceId = await insertPostponementOccurrence({
      kind: "once",
      at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(
      (
        await postponeRequest(occurrenceId, {
          until: new Date(Date.now() - 1).toISOString(),
        })
      ).status,
    ).toBe(400);
    for (const minutes of [0, -1, 1.5]) {
      expect((await postponeRequest(occurrenceId, { minutes })).status).toBe(
        400,
      );
    }
  });

  it("prevents authenticated callers from bypassing the bounded postponement service", async () => {
    const occurrenceId = await insertPostponementOccurrence({
      kind: "once",
      at: new Date(Date.now() - 60_000).toISOString(),
    });
    const response = await fetch(
      "http://127.0.0.1:55421/rest/v1/rpc/postpone_occurrence",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_occurrence_id: occurrenceId,
          p_owner_id: ownerId,
          p_until: new Date(Date.now() + 60_000).toISOString(),
          p_next_occurrence_at: null,
          p_schedule_revision: 1,
          p_occurrence_count: 1,
        }),
      },
    );
    expect(response.status).toBe(403);
    const client = await pool.connect();
    try {
      await client.query(
        "select set_config('request.jwt.claim.sub', $1, false)",
        [ownerId],
      );
      await expect(
        client.query("select public.act_on_occurrence($1, 'postponed', 75)", [
          occurrenceId,
        ]),
      ).rejects.toThrow("validated");
    } finally {
      await client.query("reset all");
      client.release();
    }
  });

  it("enforces schedule invariants and occurrence limits transactionally", async () => {
    await expect(
      pool.query(
        `insert into public.reminders(
          id, owner_id, title, schedule, timezone, sound
        ) values ('invalid', $1, 'Invalid', '{"expression":"0 9 * * *"}',
          'UTC', '{"mode":"default"}')`,
        [ownerId],
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `insert into public.reminders(
          id, owner_id, title, schedule, timezone, sound
        ) values (
          'daily-times', $1, 'Daily times',
          '{"kind":"daily-times","times":["09:15","12:30","18:00","21:45"]}',
          'UTC', '{"mode":"default"}'
        )`,
        [ownerId],
      ),
    ).resolves.toBeDefined();
    await expect(
      pool.query(
        `insert into public.reminders(
          id, owner_id, title, schedule, timezone, sound
        ) values (
          'duplicate-times', $1, 'Duplicate times',
          '{"kind":"daily-times","times":["09:00","09:00"]}',
          'UTC', '{"mode":"default"}'
        )`,
        [ownerId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `insert into public.reminders(
          id, owner_id, title, schedule, timezone, sound
        ) values (
          'too-many-times', $1, 'Too many times', $2::jsonb,
          'UTC', '{"mode":"default"}'
        )`,
        [
          ownerId,
          JSON.stringify({
            kind: "daily-times",
            times: Array.from(
              { length: 25 },
              (_value, index) =>
                `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
            ),
          }),
        ],
      ),
    ).rejects.toThrow();

    const { id, scheduledAt } = await insertReminder({
      id: "limited-reminder",
      occurrenceLimit: 1,
    });
    const first = await pool.query<{ claimed: boolean }>(
      `select public.prepare_occurrence_delivery(
        $1, $2, $3, 1, $4, $5, now(), now() - interval '5 minutes'
      ) as claimed`,
      [
        `${id}:${scheduledAt.toISOString()}`,
        id,
        ownerId,
        scheduledAt.toISOString(),
        crypto.randomUUID(),
      ],
    );
    const secondAt = new Date(scheduledAt.getTime() + 60_000);
    const second = await pool.query<{ claimed: boolean }>(
      `select public.prepare_occurrence_delivery(
        $1, $2, $3, 1, $4, $5, now(), now() - interval '5 minutes'
      ) as claimed`,
      [
        `${id}:${secondAt.toISOString()}`,
        id,
        ownerId,
        secondAt.toISOString(),
        crypto.randomUUID(),
      ],
    );
    expect(first.rows[0]?.claimed).toBe(true);
    expect(second.rows[0]?.claimed).toBe(false);
    const count = await pool.query<{ occurrence_count: string }>(
      "select occurrence_count from public.reminders where id = $1 and owner_id = $2",
      [id, ownerId],
    );
    expect(Number(count.rows[0]?.occurrence_count)).toBe(1);
  });

  it("allows account deletion cascades without creating tombstones", async () => {
    await insertReminder({ id: "account-delete-reminder" });
    await expect(
      pool.query("delete from auth.users where id = $1", [ownerId]),
    ).resolves.toBeDefined();
    const tombstones = await pool.query(
      "select * from public.reminder_tombstones where owner_id = $1",
      [ownerId],
    );
    expect(tombstones.rowCount).toBe(0);
  });

  it("enforces cross-user RLS and occurrence-action isolation", async () => {
    const secondOwner = "22222222-2222-4222-8222-222222222222";
    await pool.query("insert into auth.users(id, email) values ($1, $2)", [
      secondOwner,
      "second@example.com",
    ]);
    await insertReminder({ id: "first-owner-reminder" });
    await pool.query(
      `insert into public.reminders(
        id, owner_id, title, schedule, timezone, sound, next_due_at
      ) values (
        'second-owner-reminder', $1, 'Second owner',
        '{"kind":"once","at":"2026-09-25T09:00:00.000Z"}',
        'UTC', '{"mode":"default"}', '2026-09-25T09:00:00.000Z'
      )`,
      [secondOwner],
    );

    const userToken = jwt("authenticated", ownerId);
    const listResponse = await fetch(
      "http://127.0.0.1:55421/rest/v1/reminders?select=id,owner_id",
      {
        headers: {
          Authorization: `Bearer ${userToken}`,
          apikey: "integration-anon-key",
        },
      },
    );
    expect(listResponse.status).toBe(200);
    const rows = (await listResponse.json()) as Array<{
      id: string;
      owner_id: string;
    }>;
    expect(rows).toEqual([{ id: "first-owner-reminder", owner_id: ownerId }]);

    const deleteResponse = await fetch(
      "http://127.0.0.1:55421/rest/v1/reminders?id=eq.second-owner-reminder",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${userToken}`,
          apikey: "integration-anon-key",
        },
      },
    );
    expect(deleteResponse.status).toBe(204);
    const remaining = await pool.query(
      `select 1 from public.reminders
       where id = 'second-owner-reminder' and owner_id = $1`,
      [secondOwner],
    );
    expect(remaining.rowCount).toBe(1);

    const schedulerPatch = await fetch(
      "http://127.0.0.1:55421/rest/v1/reminders?id=eq.first-owner-reminder",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${userToken}`,
          apikey: "integration-anon-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          next_due_at: "2099-01-01T00:00:00.000Z",
          occurrence_count: 999,
          schedule_revision: 999,
        }),
      },
    );
    expect(schedulerPatch.ok).toBe(false);
    const protectedState = await pool.query<{
      occurrence_count: string;
      schedule_revision: number;
    }>(
      `select occurrence_count, schedule_revision
       from public.reminders
       where id = 'first-owner-reminder' and owner_id = $1`,
      [ownerId],
    );
    expect(Number(protectedState.rows[0]?.occurrence_count)).toBe(0);
    expect(protectedState.rows[0]?.schedule_revision).toBe(1);

    await pool.query(
      `insert into public.reminder_tombstones(id, owner_id)
       values ('deleted-reminder', $1)`,
      [ownerId],
    );
    const tombstoneDelete = await fetch(
      "http://127.0.0.1:55421/rest/v1/reminder_tombstones?id=eq.deleted-reminder",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${userToken}`,
          apikey: "integration-anon-key",
        },
      },
    );
    expect([200, 204, 401, 403]).toContain(tombstoneDelete.status);
    const tombstone = await pool.query(
      `select 1 from public.reminder_tombstones
       where id = 'deleted-reminder' and owner_id = $1`,
      [ownerId],
    );
    expect(tombstone.rowCount).toBe(1);
  });

  it("does not let another owner claim a push token without revocation proof", async () => {
    const secondOwner = "22222222-2222-4222-8222-222222222222";
    await pool.query("insert into auth.users(id, email) values ($1, $2)", [
      secondOwner,
      "second@example.com",
    ]);
    await pool.query(
      `insert into public.devices(
        id, owner_id, platform, token, deregistration_token
      ) values ('second-device', $1, 'ios', 'shared-token', $2)`,
      [secondOwner, crypto.randomUUID()],
    );

    const response = await fetch(
      "http://127.0.0.1:55421/rest/v1/rpc/claim_device_token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
          apikey: "integration-anon-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_device_id: "attacker-device",
          p_platform: "ios",
          p_token: "shared-token",
          p_deregistration_token: crypto.randomUUID(),
          p_existing_deregistration_token: null,
        }),
      },
    );
    expect(response.ok).toBe(false);
    const device = await pool.query<{ owner_id: string }>(
      "select owner_id from public.devices where id = 'second-device'",
    );
    expect(device.rows[0]?.owner_id).toBe(secondOwner);
  });
});

describe("Edge Function state transitions", () => {
  it("rejects unauthenticated account deletion and deletes only the authenticated user", async () => {
    await insertReminder({ id: "delete-account-edge-reminder" });

    const unauthenticated = await fetch("http://127.0.0.1:55434/", {
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    const before = await pool.query("select 1 from auth.users where id = $1", [
      ownerId,
    ]);
    expect(before.rowCount).toBe(1);

    const authenticated = await fetch("http://127.0.0.1:55434/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
      },
    });
    expect(authenticated.status).toBe(200);
    const users = await pool.query("select 1 from auth.users where id = $1", [
      ownerId,
    ]);
    expect(users.rowCount).toBe(0);
    const reminders = await pool.query(
      "select 1 from public.reminders where owner_id = $1",
      [ownerId],
    );
    expect(reminders.rowCount).toBe(0);
    const tombstones = await pool.query(
      "select 1 from public.reminder_tombstones where owner_id = $1",
      [ownerId],
    );
    expect(tombstones.rowCount).toBe(0);
  });

  it("dispatches a due reminder through PostgREST and transactional RPCs", async () => {
    const { id, scheduledAt } = await insertReminder({
      id: "dispatch-reminder",
    });
    await pool.query(
      `update public.dispatch_state
       set last_dispatched_at = $1
       where id = true`,
      [new Date(scheduledAt.getTime() - 10_000).toISOString()],
    );

    const response = await fetch("http://127.0.0.1:55432/", {
      method: "POST",
      headers: { "x-cron-secret": "integration-cron-secret" },
    });
    expect(response.status).toBe(200);

    const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
    const occurrence = await pool.query<{
      status: string;
      delivered_at: Date | null;
    }>(
      `select status, delivered_at from public.occurrences
       where id = $1 and owner_id = $2`,
      [occurrenceId, ownerId],
    );
    expect(occurrence.rows[0]?.status).toBe("triggered");
    expect(occurrence.rows[0]?.delivered_at).not.toBeNull();
    const history = await pool.query(
      `select 1 from public.history
       where occurrence_id = $1 and owner_id = $2
         and event_type = 'triggered'`,
      [occurrenceId, ownerId],
    );
    expect(history.rowCount).toBe(1);
  });

  it.each([
    ["cron", "until"],
    ["daily-times", "until"],
    ["cron", "count"],
    ["daily-times", "count"],
  ] as const)(
    "dispatches %s schedules with a %s ending and stops at the bound",
    async (kind, ending) => {
      const first = new Date(
        Math.floor(Date.now() / 60_000) * 60_000 - 3 * 60_000,
      );
      const last = new Date(first.getTime() + 60_000);
      const times = [first, last]
        .map((date) => date.toISOString().slice(11, 16))
        .sort();
      const schedule = {
        ...(kind === "cron"
          ? { kind, expression: "* * * * *" }
          : { kind, times }),
        startAt: first.toISOString(),
        ...(ending === "until"
          ? { endAt: last.toISOString() }
          : { occurrenceLimit: 1 }),
      };
      const { id } = await insertReminder({ schedule, scheduledAt: first });
      await pool.query(
        `update public.dispatch_state set last_dispatched_at = $1 where id = true`,
        [new Date(first.getTime() - 10_000).toISOString()],
      );
      const dispatch = () =>
        fetch("http://127.0.0.1:55432/", {
          method: "POST",
          headers: { "x-cron-secret": "integration-cron-secret" },
        });
      expect((await dispatch()).status).toBe(200);
      const recorded = await pool.query<{ scheduled_at: Date }>(
        "select scheduled_at from public.occurrences where reminder_id = $1 and owner_id = $2 order by scheduled_at",
        [id, ownerId],
      );
      expect(
        recorded.rows.map((row) => row.scheduled_at.toISOString()),
      ).toEqual(
        ending === "until"
          ? [first.toISOString(), last.toISOString()]
          : [first.toISOString()],
      );
      expect((await dispatch()).status).toBe(200);
      const state = await pool.query<{ occurrence_count: number }>(
        "select occurrence_count from public.reminders where id = $1 and owner_id = $2",
        [id, ownerId],
      );
      expect(Number(state.rows[0]?.occurrence_count)).toBe(
        ending === "until" ? 2 : 1,
      );
    },
  );

  it("tracks each browser independently across an occurrence delivery retry", async () => {
    const { id, scheduledAt } = await insertReminder();
    const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
    const firstLease = crypto.randomUUID();
    const secondLease = crypto.randomUUID();
    for (const deviceId of ["browser-one", "browser-two"]) {
      await pool.query(
        `insert into public.devices(id, owner_id, platform, token)
         values ($1, $2, 'web', $1)`,
        [deviceId, ownerId],
      );
    }
    const prepared = await pool.query<{ accepted: boolean }>(
      `select public.prepare_occurrence_delivery($1, $2, $3, 1, $4, $5,
       now(), now() - interval '5 minutes') as accepted`,
      [occurrenceId, id, ownerId, scheduledAt.toISOString(), firstLease],
    );
    expect(prepared.rows[0]?.accepted).toBe(true);
    const firstDelivery = await pool.query<{ accepted: boolean }>(
      "select public.record_occurrence_device_delivery($1, $2, 'browser-one', $3) as accepted",
      [occurrenceId, ownerId, firstLease],
    );
    expect(firstDelivery.rows[0]?.accepted).toBe(true);
    await pool.query(
      "select public.defer_occurrence_delivery($1, $2, $3, now(), 1)",
      [occurrenceId, ownerId, firstLease],
    );
    const pending = await pool.query<{ id: string }>(
      `select device.id from public.devices device
       where device.owner_id = $1 and device.enabled
         and not exists (
           select 1 from public.occurrence_device_deliveries delivery
           where delivery.device_id = device.id and delivery.owner_id = $1
             and delivery.occurrence_id = $2
         ) order by device.id`,
      [ownerId, occurrenceId],
    );
    expect(pending.rows.map(({ id }) => id)).toEqual(["browser-two"]);
    const claimed = await pool.query<{ accepted: boolean }>(
      `select public.claim_occurrence_delivery($1, $2, $3, 1, $4,
       now() + interval '2 minutes', now() - interval '5 minutes') as accepted`,
      [occurrenceId, ownerId, id, secondLease],
    );
    expect(claimed.rows[0]?.accepted).toBe(true);
    await pool.query(
      "select public.record_occurrence_device_delivery($1, $2, 'browser-two', $3)",
      [occurrenceId, ownerId, secondLease],
    );
    const delivered = await pool.query<{ device_id: string }>(
      `select device_id from public.occurrence_device_deliveries
       where owner_id = $1 and occurrence_id = $2 order by device_id`,
      [ownerId, occurrenceId],
    );
    expect(delivered.rows.map(({ device_id }) => device_id)).toEqual([
      "browser-one",
      "browser-two",
    ]);
  });

  it("does not disable a refreshed browser token when an old delivery fails", async () => {
    const oldToken = JSON.stringify({
      endpoint: "https://fcm.googleapis.com/old",
      keys: { auth: "auth", p256dh: "key" },
    });
    const newToken = JSON.stringify({
      endpoint: "https://fcm.googleapis.com/new",
      keys: { auth: "auth", p256dh: "key" },
    });
    await pool.query(
      `insert into public.devices(id, owner_id, platform, token) values ('refreshed-browser', $1, 'web', $2)`,
      [ownerId, newToken],
    );
    const url = new URL("http://127.0.0.1:55421/rest/v1/devices");
    url.searchParams.set("id", "eq.refreshed-browser");
    url.searchParams.set("owner_id", `eq.${ownerId}`);
    url.searchParams.set("token", `eq.${oldToken}`);
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${jwt("service_role")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(204);
    const device = await pool.query<{ enabled: boolean; token: string }>(
      "select enabled, token from public.devices where id = 'refreshed-browser'",
    );
    expect(device.rows[0]).toEqual({ enabled: true, token: newToken });
  });

  it("keeps an existing count when an authenticated edit changes the limit", async () => {
    const { id, scheduledAt } = await insertReminder({
      schedule: {
        kind: "daily-times",
        times: ["09:00", "12:00"],
        occurrenceLimit: 3,
      },
    });
    await pool.query(
      `insert into public.occurrences(id, reminder_id, owner_id, reminder_revision, scheduled_at, status)
       values ($1, $2, $3, 1, $4, 'completed')`,
      [
        `${id}:${scheduledAt.toISOString()}`,
        id,
        ownerId,
        scheduledAt.toISOString(),
      ],
    );
    const response = await fetch(
      `http://127.0.0.1:55421/rest/v1/reminders?id=eq.${id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schedule: {
            kind: "daily-times",
            times: ["09:00", "12:00"],
            occurrenceLimit: 5,
          },
          revision: 2,
        }),
      },
    );
    expect(response.status).toBe(204);
    const state = await pool.query<{ occurrence_count: number }>(
      "select occurrence_count from public.reminders where id = $1 and owner_id = $2",
      [id, ownerId],
    );
    expect(Number(state.rows[0]?.occurrence_count)).toBe(1);
  });

  it.each([
    { occurrenceLimit: 0 },
    { occurrenceLimit: 1.5 },
    { endAt: "invalid" },
    { startAt: "2026-10-10T09:00:00Z", endAt: "2026-10-09T09:00:00Z" },
  ])("rejects invalid daily recurrence bounds %j", async (bounds) => {
    await expect(
      insertReminder({
        schedule: { kind: "daily-times", times: ["09:00", "12:00"], ...bounds },
      }),
    ).rejects.toThrow();
  });

  it("dispatches reminders with multiple daily times", async () => {
    const scheduledAt = new Date();
    scheduledAt.setUTCSeconds(0, 0);
    const secondHour = (scheduledAt.getUTCHours() + 1) % 24;
    const dailyTimes = [
      `${String(scheduledAt.getUTCHours()).padStart(2, "0")}:${String(
        scheduledAt.getUTCMinutes(),
      ).padStart(2, "0")}`,
      `${String(secondHour).padStart(2, "0")}:${String(
        scheduledAt.getUTCMinutes(),
      ).padStart(2, "0")}`,
    ].sort();
    const { id } = await insertReminder({
      id: "daily-times-dispatch",
      schedule: { kind: "daily-times", times: dailyTimes },
      scheduledAt,
    });
    await pool.query(
      `update public.dispatch_state
       set last_dispatched_at = $1
       where id = true`,
      [new Date(scheduledAt.getTime() - 10_000).toISOString()],
    );

    const response = await fetch("http://127.0.0.1:55432/", {
      method: "POST",
      headers: { "x-cron-secret": "integration-cron-secret" },
    });
    expect(response.status).toBe(200);

    const occurrence = await pool.query<{ scheduled_at: Date }>(
      `select scheduled_at from public.occurrences
       where reminder_id = $1 and owner_id = $2`,
      [id, ownerId],
    );
    expect(occurrence.rows[0]?.scheduled_at.toISOString()).toBe(
      scheduledAt.toISOString(),
    );
  });

  it("applies occurrence actions and clears delivery state atomically", async () => {
    const { id, scheduledAt } = await insertReminder({
      id: "action-reminder",
    });
    const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
    const deviceId = "integration-device";
    const leaseId = crypto.randomUUID();
    await pool.query(
      `insert into public.devices(
        id, owner_id, platform, token, deregistration_token
      ) values ($1, $2, 'ios', 'ExponentPushToken[integration]', $3)`,
      [deviceId, ownerId, crypto.randomUUID()],
    );
    await pool.query(
      `insert into public.occurrences(
        id, reminder_id, owner_id, reminder_revision, scheduled_at,
        status, delivery_lease_id, acted_at
      ) values ($1, $2, $3, 1, $4, 'delivering', $5, now())`,
      [occurrenceId, id, ownerId, scheduledAt.toISOString(), leaseId],
    );
    await pool.query(
      `select public.record_expo_push_ticket(
        'ticket-integration', $1, $2, $3, $4
      )`,
      [occurrenceId, ownerId, deviceId, leaseId],
    );

    const response = await fetch("http://127.0.0.1:55431/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        occurrenceId,
        action: "snooze",
        minutes: 10,
      }),
    });
    expect(response.status).toBe(200);
    const occurrence = await pool.query<{ status: string }>(
      `select status from public.occurrences
       where id = $1 and owner_id = $2`,
      [occurrenceId, ownerId],
    );
    expect(occurrence.rows[0]?.status).toBe("postponed");
    const tickets = await pool.query(
      "select 1 from public.expo_push_tickets where occurrence_id = $1",
      [occurrenceId],
    );
    expect(tickets.rowCount).toBe(0);
  });

  it.each(["dismiss", "complete", "snooze"] as const)(
    "applies %s to a missed occurrence without changing future repeats",
    async (action) => {
      const { id, scheduledAt } = await insertReminder({
        id: "missed-action-reminder",
        schedule: { kind: "cron", expression: "0 9 * * *" },
      });
      const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
      await pool.query(
        `insert into public.occurrences(
          id, reminder_id, owner_id, reminder_revision, scheduled_at, status
        ) values ($1, $2, $3, 1, $4, 'missed')`,
        [occurrenceId, id, ownerId, scheduledAt.toISOString()],
      );
      const response = await fetch("http://127.0.0.1:55431/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          occurrenceId,
          action,
          ...(action === "snooze" ? { minutes: 10 } : {}),
        }),
      });
      expect(response.status).toBe(200);
      const expectedStatus =
        action === "complete"
          ? "completed"
          : action === "dismiss"
            ? "dismissed"
            : "postponed";
      const occurrence = await pool.query<{
        status: string;
        snoozed_until: Date | null;
        acted_at: Date;
      }>(
        "select status, snoozed_until, acted_at from public.occurrences where id = $1",
        [occurrenceId],
      );
      expect(occurrence.rows[0]?.status).toBe(expectedStatus);
      expect(occurrence.rows[0]?.acted_at).toBeInstanceOf(Date);
      if (action === "snooze")
        expect(occurrence.rows[0]?.snoozed_until).toBeInstanceOf(Date);
      else expect(occurrence.rows[0]?.snoozed_until).toBeNull();
      const events = await pool.query<{ event_type: string }>(
        "select event_type from public.history where occurrence_id = $1",
        [occurrenceId],
      );
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        expectedStatus,
      ]);
      const reminder = await pool.query<{ status: string; schedule: object }>(
        "select status, schedule from public.reminders where id = $1",
        [id],
      );
      expect(reminder.rows[0]).toMatchObject({
        status: "active",
        schedule: { kind: "cron", expression: "0 9 * * *" },
      });
    },
  );

  it("completes an in-flight occurrence without allowing a stale delivery to overwrite it", async () => {
    const { id, scheduledAt } = await insertReminder({
      id: "complete-delivery",
    });
    const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
    const leaseId = crypto.randomUUID();
    await pool.query(
      `insert into public.occurrences(
        id, reminder_id, owner_id, reminder_revision, scheduled_at,
        status, delivery_lease_id
      ) values ($1, $2, $3, 1, $4, 'delivering', $5)`,
      [occurrenceId, id, ownerId, scheduledAt.toISOString(), leaseId],
    );
    const headers = {
      Authorization: `Bearer ${jwt("authenticated", ownerId)}`,
      "Content-Type": "application/json",
    };
    const response = await fetch("http://127.0.0.1:55431/", {
      method: "POST",
      headers,
      body: JSON.stringify({ occurrenceId, action: "complete" }),
    });
    expect(response.status).toBe(200);
    const stale = await pool.query<{ updated: boolean }>(
      "select public.complete_occurrence_delivery($1, $2, $3, now()) as updated",
      [occurrenceId, ownerId, leaseId],
    );
    expect(stale.rows[0]?.updated).toBe(false);
    const repeated = await fetch("http://127.0.0.1:55431/", {
      method: "POST",
      headers,
      body: JSON.stringify({ occurrenceId, action: "complete" }),
    });
    expect(repeated.status).toBe(404);
    const events = await pool.query(
      "select 1 from public.history where occurrence_id = $1 and event_type = 'completed'",
      [occurrenceId],
    );
    expect(events.rowCount).toBe(1);
  });

  it("deregisters a device with its revocation token", async () => {
    const deviceId = "deregister-integration-device";
    const token = crypto.randomUUID();
    await pool.query(
      `insert into public.devices(
        id, owner_id, platform, token, deregistration_token
      ) values ($1, $2, 'android', 'ExponentPushToken[deregister]', $3)`,
      [deviceId, ownerId, token],
    );
    const response = await fetch("http://127.0.0.1:55433/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deviceId, token }),
    });
    expect(response.status).toBe(200);
    const devices = await pool.query(
      "select 1 from public.devices where id = $1",
      [deviceId],
    );
    expect(devices.rowCount).toBe(0);
  });

  it("does not disable a refreshed token from a stale Expo receipt", async () => {
    const { id, scheduledAt } = await insertReminder({
      id: "refreshed-token-reminder",
    });
    const occurrenceId = `${id}:${scheduledAt.toISOString()}`;
    const deviceId = "refreshed-token-device";
    const leaseId = crypto.randomUUID();
    await pool.query(
      `insert into public.devices(
        id, owner_id, platform, token, deregistration_token
      ) values ($1, $2, 'ios', 'old-token', $3)`,
      [deviceId, ownerId, crypto.randomUUID()],
    );
    await pool.query(
      `insert into public.occurrences(
        id, reminder_id, owner_id, reminder_revision, scheduled_at,
        status, delivery_lease_id, acted_at
      ) values ($1, $2, $3, 1, $4, 'delivering', $5, now())`,
      [occurrenceId, id, ownerId, scheduledAt.toISOString(), leaseId],
    );
    await pool.query(
      `select public.record_expo_push_ticket(
        'stale-token-ticket', $1, $2, $3, $4
      )`,
      [occurrenceId, ownerId, deviceId, leaseId],
    );
    await pool.query(
      `update public.devices set token = 'refreshed-token'
       where id = $1 and owner_id = $2`,
      [deviceId, ownerId],
    );

    await pool.query(
      "select public.fail_expo_push_ticket('stale-token-ticket', true)",
    );

    const device = await pool.query<{ enabled: boolean; token: string }>(
      `select enabled, token from public.devices
       where id = $1 and owner_id = $2`,
      [deviceId, ownerId],
    );
    expect(device.rows[0]).toEqual({
      enabled: true,
      token: "refreshed-token",
    });
  });
});
