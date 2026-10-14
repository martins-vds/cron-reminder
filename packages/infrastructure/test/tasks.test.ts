import { describe, expect, it } from "vitest";
import { createTask, type Task } from "@cron-reminder/domain";
import {
  JsonTaskRepository,
  OfflineTaskSynchronizationAdapter,
  SupabaseTaskRepository,
  exportBackup,
  importBackup,
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    ...createTask({
      id: "task-1",
      ownerId: "user-1",
      title: "Submit report",
      dueAt: "2026-10-15T17:00:00.000Z",
      reminderPolicy: {
        primary: { kind: "once", at: "2026-10-15T16:00:00.000Z" },
        overdue: { kind: "cron", expression: "0 * * * *" },
      },
      timezone: "UTC",
      now: "2026-10-13T12:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("JSON task persistence and synchronization", () => {
  it("stores tasks by owner and retains deletion tombstones", async () => {
    const repository = new JsonTaskRepository(new MemoryStore());
    const first = task();
    const second = task({ ownerId: "user-2", title: "Other account" });
    await repository.save(first);
    await repository.save(second);
    expect(await repository.get("user-1", first.id)).toEqual(first);
    expect(await repository.get("user-2", second.id)).toEqual(second);

    await repository.delete("user-1", first.id);
    expect(await repository.get("user-1", first.id)).toBeNull();
    expect(await repository.listDeletedIds("user-1")).toEqual([first.id]);
    expect(await repository.get("user-2", second.id)).toEqual(second);
  });

  it("pushes offline deletions instead of resurrecting remote tasks", async () => {
    const local = new JsonTaskRepository(new MemoryStore(), "local-tasks");
    const remote = new JsonTaskRepository(new MemoryStore(), "remote-tasks");
    const value = task();
    await local.save(value);
    await remote.save(value);
    await local.setSyncedRevision(value.ownerId, value.id, value.revision);
    await local.delete(value.ownerId, value.id);

    const conflicts = await new OfflineTaskSynchronizationAdapter(
      local,
      remote,
    ).synchronize(value.ownerId);

    expect(conflicts).toEqual([]);
    expect(await remote.get(value.ownerId, value.id)).toBeNull();
    expect(await remote.listDeletedIds(value.ownerId)).toEqual([value.id]);
  });
});

describe("task backup v3", () => {
  it("round-trips tasks while preserving v1 and v2 imports", () => {
    const value = task({ status: "completed" });
    const exported = exportBackup(
      [],
      new Date("2026-10-13T12:00:00.000Z"),
      [],
      [value],
    );
    expect(JSON.parse(exported)).toMatchObject({
      version: 3,
      reminders: [],
      tasks: [{ id: value.id, status: "completed" }],
    });
    const result = importBackup(exported, [], "new-owner");
    expect(result.tasksImported).toBe(1);
    expect(result.tasks).toEqual([{ ...value, ownerId: "new-owner" }]);

    for (const version of [1, 2] as const) {
      const legacy = JSON.stringify({
        version,
        exportedAt: "2026-10-13T12:00:00.000Z",
        reminders: [],
        ...(version === 2 ? { categories: [] } : {}),
      });
      expect(importBackup(legacy, [], "user-1").tasks).toEqual([]);
    }
  });

  it("reports invalid task payloads without rejecting valid reminders", () => {
    const backup = JSON.stringify({
      version: 3,
      exportedAt: "2026-10-13T12:00:00.000Z",
      reminders: [],
      categories: [],
      tasks: [{ ...task(), dueAt: "invalid" }],
    });
    expect(importBackup(backup, [], "user-1")).toMatchObject({
      tasks: [],
      tasksImported: 0,
      tasksInvalid: 1,
    });
  });
});

class FakeTaskSupabaseClient {
  readonly tasks = new Map<string, Record<string, unknown>>();
  readonly tombstones: Array<{ id: string; owner_id: string }> = [];

  from(table: string) {
    if (table === "tasks") return this.tasksTable();
    if (table === "task_tombstones") return this.tombstonesTable();
    throw new Error(`Unsupported table ${table}`);
  }

  private tasksTable() {
    const matching = (criteria: Record<string, unknown>) =>
      [...this.tasks.values()].filter((row) =>
        Object.entries(criteria).every(
          ([column, value]) => row[column] === value,
        ),
      );
    return {
      select: () => {
        const criteria: Record<string, unknown> = {};
        let minimumId: string | null = null;
        const rows = () =>
          matching(criteria)
            .filter((row) => minimumId === null || String(row.id) > minimumId)
            .sort((left, right) =>
              String(left.id).localeCompare(String(right.id)),
            );
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
          limit: () => query,
          then: (
            resolve: (result: {
              data: Record<string, unknown>[];
              error: null;
            }) => void,
          ) => resolve({ data: rows(), error: null }),
          maybeSingle: async () => ({
            data: rows()[0] ?? null,
            error: null,
          }),
        };
        return query;
      },
      insert: async (row: Record<string, unknown>) => {
        this.tasks.set(String(row.id), row);
        return { error: null };
      },
      update: () => {
        throw new Error("Update is not used by this focused fake.");
      },
      delete: () => {
        const criteria: Record<string, unknown> = {};
        const query = {
          eq: (column: string, value: unknown) => {
            criteria[column] = value;
            return query;
          },
          then: (resolve: (result: { error: null }) => void) => {
            for (const row of matching(criteria))
              this.tasks.delete(String(row.id));
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
        const query = {
          eq: (_column: string, value: string) => {
            ownerId = value;
            return query;
          },
          gt: () => query,
          order: () => query,
          limit: () => query,
          then: (
            resolve: (result: {
              data: Array<{ id: string; owner_id: string }>;
              error: null;
            }) => void,
          ) =>
            resolve({
              data: this.tombstones.filter((item) => item.owner_id === ownerId),
              error: null,
            }),
        };
        return query;
      },
      upsert: async (row: { id: string; owner_id: string }) => {
        this.tombstones.push(row);
        return { error: null };
      },
    };
  }
}

describe("Supabase task repository", () => {
  it("maps task rows, calculates the due cursor, and writes tombstones", async () => {
    const fake = new FakeTaskSupabaseClient();
    const repository = new SupabaseTaskRepository(
      fake as unknown as ConstructorParameters<
        typeof SupabaseTaskRepository
      >[0],
    );
    const value = task();
    await repository.save(value);
    expect(fake.tasks.get(value.id)).toMatchObject({
      owner_id: value.ownerId,
      due_at: value.dueAt,
      reminder_policy: value.reminderPolicy,
      next_due_at: "2026-10-15T16:00:00.000Z",
    });
    expect(await repository.get(value.ownerId, value.id)).toEqual(value);

    await repository.delete(value.ownerId, value.id);
    expect(await repository.get(value.ownerId, value.id)).toBeNull();
    expect(await repository.listDeletedIds(value.ownerId)).toEqual([value.id]);
  });
});
