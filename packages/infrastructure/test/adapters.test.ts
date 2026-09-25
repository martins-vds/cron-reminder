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
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
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
    const loaded = await repository.get(original.ownerId, original.id);
    expect(loaded).toEqual(original);
    expect(loaded).not.toBe(original);
    await repository.delete(original.ownerId, original.id);
    expect(await repository.get(original.ownerId, original.id)).toBeNull();
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

  it("isolates identical reminder IDs and sync metadata by owner", async () => {
    const repository = new JsonReminderRepository(new MemoryStore());
    const first = reminder({ ownerId: "u1", title: "First account" });
    const second = reminder({ ownerId: "u2", title: "Second account" });
    await repository.save(first);
    await repository.save(second);
    await repository.setSyncedRevision("u1", first.id, 2);
    await repository.setSyncedRevision("u2", second.id, 5);

    expect((await repository.get("u1", first.id))?.title).toBe("First account");
    expect((await repository.get("u2", second.id))?.title).toBe(
      "Second account",
    );
    expect(await repository.getSyncedRevision("u1", first.id)).toBe(2);
    expect(await repository.getSyncedRevision("u2", second.id)).toBe(5);

    await repository.delete("u2", second.id);
    expect(await repository.get("u2", second.id)).toBeNull();
    expect(await repository.get("u1", first.id)).toEqual(first);
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

  it("round-trips reminders with multiple daily times", () => {
    const dailyTimesReminder = reminder({
      schedule: {
        kind: "daily-times",
        times: ["09:15", "12:30", "18:00", "21:45"],
      },
    });
    const result = importBackup(
      exportBackup([dailyTimesReminder], new Date("2026-09-23T00:00:00.000Z")),
      [],
      "u1",
    );
    expect(result.invalid).toBe(0);
    expect(result.merged[0]?.schedule).toEqual(dailyTimesReminder.schedule);
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
    {
      overrides: { createdAt: "2026-02-30T09:00:00.000Z" },
      label: "impossible creation timestamp",
    },
    {
      overrides: { updatedAt: "2026-09-24T09:00:00" },
      label: "timezone-free update timestamp",
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
    const matchingRows = (criteria: Record<string, unknown>) =>
      [...this.reminders.values()].filter((row) =>
        Object.entries(criteria).every(
          ([column, value]) => row[column] === value,
        ),
      );
    return {
      select: () => {
        const criteria: Record<string, unknown> = {};
        let minimumId: string | null = null;
        let limit: number | null = null;
        const rows = () => {
          const matched = matchingRows(criteria)
            .filter((row) => minimumId === null || String(row.id) > minimumId)
            .sort((left, right) =>
              String(left.id).localeCompare(String(right.id)),
            );
          return limit === null ? matched : matched.slice(0, limit);
        };
        const query = {
          eq: (column: string, value: unknown) => {
            criteria[column] = value;
            return query;
          },
          gt: (_column: string, value: string) => {
            minimumId = value;
            return query;
          },
          order: () => query,
          limit: (value: number) => {
            limit = value;
            return query;
          },
          then(
            resolve: (result: {
              data: Record<string, unknown>[];
              error: null;
            }) => void,
          ) {
            resolve({ data: rows(), error: null });
          },
          maybeSingle: async () => ({
            data: rows()[0] ?? null,
            error: null,
          }),
        };
        return query;
      },
      insert: async (row: Record<string, unknown>) => {
        this.reminders.set(row.id as string, row);
        return { error: null };
      },
      update: (row: Record<string, unknown>) => {
        const criteria: Record<string, unknown> = {};
        const query = {
          eq: (column: string, value: unknown) => {
            criteria[column] = value;
            return query;
          },
          select: () => {
            const existing = matchingRows(criteria)[0];
            if (!existing) return Promise.resolve({ data: [], error: null });
            this.reminders.set(String(existing.id), {
              ...existing,
              ...row,
            });
            return Promise.resolve({
              data: [{ id: existing.id }],
              error: null,
            });
          },
        };
        return query;
      },
      delete: () => {
        const criteria: Record<string, unknown> = {};
        const query = {
          eq: (column: string, value: unknown) => {
            criteria[column] = value;
            return query;
          },
          then: (resolve: (result: { error: null }) => void) => {
            this.operations.push("delete");
            for (const existing of matchingRows(criteria)) {
              this.reminders.delete(String(existing.id));
            }
            resolve({ error: null });
          },
        };
        return query;
      },
    };
  }

  private tombstonesTable() {
    return {
      select: () => {
        let ownerId = "";
        let minimumId: string | null = null;
        let limit: number | null = null;
        const query = {
          eq: (_column: string, value: string) => {
            ownerId = value;
            return query;
          },
          gt: (_column: string, value: string) => {
            minimumId = value;
            return query;
          },
          order: () => query,
          limit: (value: number) => {
            limit = value;
            return query;
          },
          then: (
            resolve: (result: {
              data: Array<{ id: string; owner_id: string }>;
              error: null;
            }) => void,
          ) => {
            let data = this.tombstones
              .filter(
                (item) =>
                  item.owner_id === ownerId &&
                  (minimumId === null || item.id > minimumId),
              )
              .sort((left, right) => left.id.localeCompare(right.id));
            if (limit !== null) data = data.slice(0, limit);
            this.tombstoneListReads++;
            if (this.tombstoneListReads === 1) this.afterFirstTombstoneList?.();
            resolve({ data, error: null });
          },
        };
        return query;
      },
      upsert: async (row: { id: string; owner_id: string }) => {
        this.operations.push("tombstone");
        this.tombstones = this.tombstones.filter(
          (item) => item.id !== row.id || item.owner_id !== row.owner_id,
        );
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
  it("preserves an overdue one-time due cursor on initial sync", async () => {
    const fake = new FakeSupabaseClient();
    const repository = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );
    const overdue = reminder({
      schedule: { kind: "once", at: "2026-01-01T09:00:00.000Z" },
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-01-01T08:00:00.000Z",
    });

    await repository.save(overdue);

    expect(fake.reminders.get(overdue.id)?.next_due_at).toBe(
      "2026-01-01T09:00:00.000Z",
    );
  });

  it("preserves the server due cursor for non-scheduling edits", async () => {
    const fake = new FakeSupabaseClient();
    const repository = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );
    const original = reminder({ revision: 1 });
    fake.reminders.set(original.id, {
      ...toDatabaseRow(original),
      next_due_at: "2026-09-25T09:00:00.000Z",
    });

    await repository.save({
      ...original,
      title: "Renamed",
      revision: 2,
      updatedAt: "2026-09-24T12:00:00.000Z",
    });

    expect(fake.reminders.get(original.id)?.next_due_at).toBe(
      "2026-09-25T09:00:00.000Z",
    );
  });

  it("accepts identical equal-revision writes and rejects divergent ones", async () => {
    const fake = new FakeSupabaseClient();
    const repository = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );
    const original = reminder({ revision: 2 });
    fake.reminders.set(original.id, toDatabaseRow(original));

    await expect(repository.save(original)).resolves.toBeUndefined();
    await expect(
      repository.save({ ...original, title: "Diverged" }),
    ).rejects.toThrow("different content");
  });

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

    await repository.delete(original.ownerId, original.id);

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

    expect(await local.get(staleLocal.ownerId, staleLocal.id)).toBeNull();
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

    expect(await local.get(staleLocal.ownerId, staleLocal.id)).toBeNull();
    expect(fake.reminders.has(staleLocal.id)).toBe(false);
  });

  it("treats equivalent database timestamp formats as the same reminder", async () => {
    const local = new JsonReminderRepository(new MemoryStore());
    const unchanged = reminder({
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    await local.save(unchanged);
    await local.setSyncedRevision(
      unchanged.ownerId,
      unchanged.id,
      unchanged.revision,
    );

    const fake = new FakeSupabaseClient();
    fake.reminders.set(unchanged.id, {
      ...toDatabaseRow(unchanged),
      created_at: "2026-09-23T00:00:00+00:00",
      updated_at: "2026-09-24T00:00:00+00:00",
    });
    const remote = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );

    const conflicts = await new OfflineSynchronizationAdapter(
      local,
      remote,
    ).synchronize(unchanged.ownerId);

    expect(conflicts).toEqual([]);
    expect(await local.get(unchanged.ownerId, unchanged.id)).toEqual(unchanged);
  });

  it("preserves divergent edits with unequal revision counters", async () => {
    const local = new JsonReminderRepository(new MemoryStore());
    const localEdit = reminder({
      title: "Local edit",
      revision: 2,
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    await local.save(localEdit);
    await local.setSyncedRevision(localEdit.ownerId, localEdit.id, 1);

    const remoteEdit = reminder({
      title: "Remote edit",
      revision: 3,
      updatedAt: "2026-09-24T01:00:00.000Z",
    });
    const fake = new FakeSupabaseClient();
    fake.reminders.set(remoteEdit.id, toDatabaseRow(remoteEdit));
    const remote = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );

    const conflicts = await new OfflineSynchronizationAdapter(
      local,
      remote,
    ).synchronize(localEdit.ownerId);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      local: { title: "Local edit", revision: 2 },
      remote: { title: "Remote edit", revision: 3 },
    });
    expect((await local.get(localEdit.ownerId, localEdit.id))?.title).toBe(
      "Local edit",
    );
    expect(fake.reminders.get(remoteEdit.id)?.title).toBe("Remote edit");
  });

  it("resolves conflicts above both branch revisions", async () => {
    const local = new JsonReminderRepository(new MemoryStore());
    const localEdit = reminder({ title: "Local edit", revision: 2 });
    const remoteEdit = reminder({ title: "Remote edit", revision: 3 });
    await local.save(localEdit);
    await local.setSyncedRevision(localEdit.ownerId, localEdit.id, 1);

    const fake = new FakeSupabaseClient();
    fake.reminders.set(remoteEdit.id, toDatabaseRow(remoteEdit));
    const remote = new SupabaseReminderRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseReminderRepository
      >[0],
    );
    const adapter = new OfflineSynchronizationAdapter(local, remote);

    await adapter.resolve(
      { id: localEdit.id, local: localEdit, remote: remoteEdit },
      localEdit,
    );

    expect((await local.get(localEdit.ownerId, localEdit.id))?.revision).toBe(
      4,
    );
    expect(fake.reminders.get(remoteEdit.id)?.revision).toBe(4);
    expect(await local.getSyncedRevision(localEdit.ownerId, localEdit.id)).toBe(
      4,
    );
  });
});
