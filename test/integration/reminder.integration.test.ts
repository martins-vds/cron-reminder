import crypto from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  scheduleRevision?: number;
  scheduledAt?: Date;
}): Promise<{ id: string; scheduledAt: Date }> {
  const id = options?.id ?? "integration-reminder";
  const scheduledAt = options?.scheduledAt ?? new Date(Date.now() - 5_000);
  const schedule = {
    kind: "once",
    at: scheduledAt.toISOString(),
    ...(options?.occurrenceLimit
      ? { occurrenceLimit: options.occurrenceLimit }
      : {}),
  };
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

describe("database migrations and delivery RPCs", () => {
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
});

describe("Edge Function state transitions", () => {
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
});
