import { describe, expect, it } from "vitest";
import { createReminder, type Reminder } from "@cron-reminder/domain";
import {
  JsonReminderRepository,
  OfflineSynchronizationAdapter,
  SupabaseReminderRepository,
  exportBackup,
  importBackup,
  mergeForSynchronization,
  type KeyValueStore,
} from "../src/index";

class MemoryStore implements KeyValueStore {
  value: string | null = null;
  async get(): Promise<string | null> {
    return this.value;
  }
  async set(_key: string, value: string): Promise<void> {
    this.value = value;
  }
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    ...createReminder({
      id: "r1",
      ownerId: "u1",
      title: "Medicine",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "UTC",
      now: "2026-09-23T00:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("local persistence", () => {
  it("stores reminders independently from domain objects", async () => {
    const repository = new JsonReminderRepository(new MemoryStore());
    const original = reminder();
    await repository.save(original);
    const loaded = await repository.get(original.id);
    expect(loaded).toEqual(original);
    expect(loaded).not.toBe(original);
    await repository.delete(original.id);
    expect(await repository.get(original.id)).toBeNull();
  });

  it("serializes concurrent saves so none are lost", async () => {
    const repository = new JsonReminderRepository(new MemoryStore());
    const reminders = Array.from({ length: 5 }, (_, index) =>
      reminder({ id: `r${index}` }),
    );
    await Promise.all(reminders.map((value) => repository.save(value)));
    const stored = await repository.list("u1");
    expect(stored.map(({ id }) => id).sort()).toEqual(
      reminders.map(({ id }) => id).sort(),
    );
  });
});

describe("versioned JSON backup", () => {
  it("exports no credentials or device tokens", () => {
    const data = exportBackup(
      [reminder()],
      new Date("2026-09-23T00:00:00.000Z"),
    );
    expect(JSON.parse(data)).toMatchObject({
      version: 1,
      reminders: [{ title: "Medicine" }],
    });
    expect(data).not.toContain("token");
  });

  it("merges new items and reports manual conflicts", () => {
    const local = reminder({ title: "Local", revision: 2 });
    const incoming = reminder({ title: "Imported", revision: 2 });
    const result = importBackup(
      exportBackup([incoming], new Date("2026-09-23T00:00:00.000Z")),
      [local],
      "u1",
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.merged).toEqual([local]);
  });

  it("rejects malformed imports", () => {
    expect(() => importBackup('{"version":99}', [], "u1")).toThrow("backup");
  });

  it("rejects reminders missing required runtime fields", () => {
    const incomplete = {
      id: "r2",
      ownerId: "someone-else",
      title: "Incomplete",
      timezone: "UTC",
      revision: 1,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      // notes, tags, sound, status, createdAt, updatedAt are missing
    };
    const backup = JSON.stringify({
      version: 1,
      exportedAt: "2026-09-23T00:00:00.000Z",
      reminders: [incomplete],
    });
    const result = importBackup(backup, [], "u1");
    expect(result.imported).toBe(0);
    expect(result.invalid).toBe(1);
    expect(result.merged).toEqual([]);
  });

  it("rejects reminders with an invalid schedule payload", () => {
    const invalidSchedule = {
      ...reminder(),
      schedule: {
        kind: "cron",
        expression: "0 9 * * *",
        startAt: "not-a-date",
      },
    };
    const backup = JSON.stringify({
      version: 1,
      exportedAt: "2026-09-23T00:00:00.000Z",
      reminders: [invalidSchedule],
    });
    const result = importBackup(backup, [], "u1");
    expect(result.invalid).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("rejects reminders with an invalid timezone", () => {
    const backup = JSON.stringify({
      version: 1,
      exportedAt: "2026-09-23T00:00:00.000Z",
      reminders: [reminder({ timezone: "Not/A_Timezone" })],
    });
    const result = importBackup(backup, [], "u1");
    expect(result.invalid).toBe(1);
    expect(result.imported).toBe(0);
  });

  it.each([
    { overrides: { title: " " }, label: "blank title" },
    { overrides: { revision: 0 }, label: "non-positive revision" },
    { overrides: { revision: 1.5 }, label: "fractional revision" },
    {
      overrides: { createdAt: "not-a-date" },
      label: "invalid creation timestamp",
    },
    {
      overrides: { updatedAt: "not-a-date" },
      label: "invalid update timestamp",
    },
  ])("rejects reminders with a $label", ({ overrides }) => {
    const backup = JSON.stringify({
      version: 1,
      exportedAt: "2026-09-23T00:00:00.000Z",
      reminders: [reminder(overrides)],
    });
    const result = importBackup(backup, [], "u1");
    expect(result.invalid).toBe(1);
    expect(result.imported).toBe(0);
  });
});

class FakeSupabaseClient {
  reminders = new Map<string, Record<string, unknown>>();
  tombstones: Array<{ id: string; owner_id: string }> = [];
  operations: string[] = [];
  tombstoneListReads = 0;
  afterFirstTombstoneList?: () => void;

  from(table: string) {
    if (table === "reminders") return this.remindersTable();
    if (table === "reminder_tombstones") return this.tombstonesTable();
    throw new Error(`Unsupported table ${table}`);
  }

  private remindersTable() {
    return {
      select: () => ({
        eq: (column: string, value: string) => {
          const rows = [...this.reminders.values()].filter(
            (row) => row[column] === value,
          );
          return {
            then(
              resolve: (result: {
                data: Record<string, unknown>[];
                error: null;
              }) => void,
            ) {
              resolve({ data: rows, error: null });
            },
            maybeSingle: async () => ({
              data: rows[0] ?? null,
              error: null,
            }),
          };
        },
      }),
      insert: async (row: Record<string, unknown>) => {
        this.reminders.set(row.id as string, row);
        return { error: null };
      },
      update: (row: Record<string, unknown>) => ({
        eq: (_c1: string, id: string) => ({
          eq: (_c2: string, expectedRevision: number) => ({
            select: () => {
              const existing = this.reminders.get(id);
              if (!existing || existing.revision !== expectedRevision) {
                return Promise.resolve({ data: [], error: null });
              }
              this.reminders.set(id, row);
              return Promise.resolve({ data: [{ id }], error: null });
            },
          }),
        }),
      }),
      delete: () => ({
        eq: (_column: string, id: string) => {
          this.operations.push("delete");
          this.reminders.delete(id);
          return Promise.resolve({ error: null });
        },
      }),
    };
  }

  private tombstonesTable() {
    return {
      select: () => ({
        eq: (_column: string, ownerId: string) => {
          const data = this.tombstones.filter(
            (item) => item.owner_id === ownerId,
          );
          this.tombstoneListReads++;
          if (this.tombstoneListReads === 1) this.afterFirstTombstoneList?.();
          return Promise.resolve({
            data,
            error: null,
          });
        },
      }),
      upsert: async (row: { id: string; owner_id: string }) => {
        this.operations.push("tombstone");
        this.tombstones = this.tombstones.filter((item) => item.id !== row.id);
        this.tombstones.push(row);
        return { error: null };
      },
    };
  }
}

function toDatabaseRow(value: Reminder): Record<string, unknown> {
  return {
    id: value.id,
    owner_id: value.ownerId,
    title: value.title,
    notes: value.notes,
    tags: value.tags,
    schedule: value.schedule,
    timezone: value.timezone,
    sound: value.sound,
    status: value.status,
    revision: value.revision,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

describe("Supabase reminder repository", () => {
  it("rejects a stale write when a concurrent update wins the race", async () => {
    const fake = new FakeSupabaseClient();
    const repository = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );
    const original = reminder({ revision: 1 });
    fake.reminders.set(original.id, toDatabaseRow(original));

    const first = repository.save({ ...original, revision: 2, title: "First" });
    const second = repository.save({
      ...original,
      revision: 2,
      title: "Second",
    });
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      "updated concurrently",
    );
  });

  it("records a tombstone when deleting a reminder", async () => {
    const fake = new FakeSupabaseClient();
    const repository = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );
    const original = reminder();
    fake.reminders.set(original.id, toDatabaseRow(original));

    await repository.delete(original.id);

    expect(fake.reminders.has(original.id)).toBe(false);
    expect(await repository.listDeletedIds("u1")).toEqual([original.id]);
    expect(fake.operations).toEqual(["tombstone", "delete"]);
  });
});

describe("synchronization", () => {
  it("does not resurrect reminders deleted on another device", () => {
    const local = reminder({ title: "Local copy" });
    const { merged } = mergeForSynchronization([local], []);
    expect(merged).toEqual([local]);
  });

  it("removes local reminders tombstoned remotely before merging", async () => {
    const local = new JsonReminderRepository(new MemoryStore());
    const staleLocal = reminder({ title: "Deleted elsewhere" });
    await local.save(staleLocal);

    const fake = new FakeSupabaseClient();
    fake.tombstones.push({ id: staleLocal.id, owner_id: staleLocal.ownerId });
    const remote = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );

    const adapter = new OfflineSynchronizationAdapter(local, remote);
    await adapter.synchronize(staleLocal.ownerId);

    expect(await local.get(staleLocal.id)).toBeNull();
  });

  it("rechecks tombstones before uploading merged reminders", async () => {
    const local = new JsonReminderRepository(new MemoryStore());
    const staleLocal = reminder({ title: "Deleted during sync" });
    await local.save(staleLocal);

    const fake = new FakeSupabaseClient();
    fake.afterFirstTombstoneList = () => {
      fake.tombstones.push({ id: staleLocal.id, owner_id: staleLocal.ownerId });
    };
    const remote = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );

    const adapter = new OfflineSynchronizationAdapter(local, remote);
    await adapter.synchronize(staleLocal.ownerId);

    expect(await local.get(staleLocal.id)).toBeNull();
    expect(fake.reminders.has(staleLocal.id)).toBe(false);
  });
});
