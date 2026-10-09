import { describe, expect, it } from "vitest";
import {
  createReminder,
  starterCategories,
  updateReminder,
} from "@cron-reminder/domain";
import {
  JsonCategoryRepository,
  JsonReminderRepository,
  SupabaseCategoryRepository,
  SupabaseAnalyticsRepository,
  clearDeletedCategoryAssignments,
  synchronizeCategories,
  exportBackup,
  importBackup,
  type DatabaseClient,
  type KeyValueStore,
} from "../src/index";

function store(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}
function fixture() {
  return createReminder({
    id: "r",
    ownerId: "owner",
    title: "Task",
    categoryId: "work",
    schedule: { kind: "cron", expression: "* * * * *" },
    timezone: "UTC",
    now: "2026-10-09T00:00:00Z",
  });
}
function remoteClient() {
  const rows: Record<string, unknown>[] = starterCategories(
    "owner",
    "2026-10-09T00:00:00Z",
  ).map((item) => ({
    id: item.id,
    owner_id: item.ownerId,
    name: item.name,
    revision: item.revision,
    updated_at: item.updatedAt,
    deleted_at: null,
  }));
  const client: DatabaseClient = {
    readPage: async (_table, owner, _order, offset, limit) => ({
      data: rows
        .filter((item) => item.owner_id === owner)
        .slice(offset, offset + limit),
      error: null,
    }),
    rpc: async (name, args) => {
      if (name === "initialize_categories") return { data: null, error: null };
      if (!args) throw new Error("Missing RPC arguments");
      const row = rows.find((item) => item.id === args.p_id);
      if (row && row.deleted_at) return { data: args.p_deleted, error: null };
      if (row && row.revision !== args.p_expected_revision)
        return { data: false, error: null };
      const updated = {
        id: args.p_id,
        owner_id: "owner",
        name: args.p_name,
        revision: args.p_revision,
        updated_at: "2026-10-09T01:00:00Z",
        deleted_at: args.p_deleted ? "2026-10-09T01:00:00Z" : null,
      };
      if (row) Object.assign(row, updated);
      else rows.push(updated);
      return { data: true, error: null };
    },
  };
  return { client, rows };
}

describe("category persistence and synchronization", () => {
  it("passes the starter locale to both local and remote initialization", async () => {
    const local = new JsonCategoryRepository(store());
    let portuguese: unknown;
    const client: DatabaseClient = {
      readPage: async () => ({ data: [], error: null }),
      rpc: async (name, args) => {
        if (name === "initialize_categories") portuguese = args?.p_portuguese;
        return { data: true, error: null };
      },
    };
    await synchronizeCategories(
      "owner",
      local,
      new SupabaseCategoryRepository(client),
      new JsonReminderRepository(store()),
      true,
    );
    expect(portuguese).toBe(true);
    expect((await local.list("owner")).map((item) => item.name)).toEqual([
      "Pessoal",
      "Trabalho",
    ]);
  });
  it("preserves unsynchronized same-ID edits as explicit conflicts", async () => {
    const local = new JsonCategoryRepository(store());
    const server = remoteClient();
    await local.save({
      ...starterCategories("owner", "2026-10-09T00:00:00Z")[0]!,
      id: "fitness",
      name: "Gym",
      revision: 2,
    });
    server.rows.push({
      id: "fitness",
      owner_id: "owner",
      name: "Exercise",
      revision: 1,
      updated_at: "2026-10-09T00:00:00Z",
      deleted_at: null,
    });
    const conflicts = await synchronizeCategories(
      "owner",
      local,
      new SupabaseCategoryRepository(server.client),
      new JsonReminderRepository(store()),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.local.name).toBe("Gym");
    expect(conflicts[0]?.remote.name).toBe("Exercise");
    expect(server.rows.find((item) => item.id === "fitness")?.name).toBe(
      "Exercise",
    );
  });
  it("initializes once and keeps account catalogs isolated", async () => {
    const repository = new JsonCategoryRepository(store());
    await repository.initialize("owner");
    const work = (await repository.list("owner"))[1]!;
    await repository.save({
      ...work,
      deletedAt: "2026-10-09T00:00:00Z",
      revision: 2,
    });
    await repository.initialize("owner");
    expect((await repository.list("owner"))[1]?.deletedAt).not.toBeNull();
    expect(await repository.list("other")).toEqual([]);
    await repository.clear("owner");
    expect(await repository.list("owner")).toEqual([]);
  });
  it("replays interrupted removal while retaining schedules and unrelated edits", async () => {
    const storage = store();
    const categories = new JsonCategoryRepository(storage);
    const reminders = new JsonReminderRepository(storage);
    await categories.initialize("owner");
    const reminder = fixture();
    await reminders.save(reminder);
    const work = (await categories.list("owner")).find(
      (item) => item.id === "work",
    )!;
    await categories.save({
      ...work,
      deletedAt: "2026-10-09T00:00:00Z",
      revision: 2,
    });
    await reminders.save(
      updateReminder(
        reminder,
        { title: "Edited offline" },
        "2026-10-09T00:30:00Z",
      ),
    );
    await clearDeletedCategoryAssignments(
      "owner",
      new JsonCategoryRepository(storage),
      reminders,
    );
    expect(await reminders.get("owner", "r")).toMatchObject({
      categoryId: null,
      title: "Edited offline",
      revision: 3,
      schedule: reminder.schedule,
    });
    const server = remoteClient();
    await synchronizeCategories(
      "owner",
      categories,
      new SupabaseCategoryRepository(server.client),
      reminders,
    );
    expect(
      server.rows.find((item) => item.id === "work")?.deleted_at,
    ).not.toBeNull();
    await categories.initialize("owner");
    expect(
      (await categories.list("owner")).find((item) => item.id === "work")
        ?.deletedAt,
    ).not.toBeNull();
  });
  it("lets deletion win over stale edits and preserves genuine rename conflicts", async () => {
    const storage = store();
    const local = new JsonCategoryRepository(storage);
    const reminders = new JsonReminderRepository(storage);
    const server = remoteClient();
    const remote = new SupabaseCategoryRepository(server.client);
    await synchronizeCategories("owner", local, remote, reminders);
    const work = (await local.list("owner")).find(
      (item) => item.id === "work",
    )!;
    await local.save({ ...work, name: "Office", revision: 2 });
    Object.assign(
      server.rows.find((item) => item.id === "work")!,
      { name: "Company", revision: 2 },
    );
    const conflicts = await synchronizeCategories(
      "owner",
      local,
      remote,
      reminders,
    );
    expect(conflicts[0]?.local.name).toBe("Office");
    expect(conflicts[0]?.remote.name).toBe("Company");
    Object.assign(
      server.rows.find((item) => item.id === "work")!,
      { revision: 3, deleted_at: "2026-10-09T02:00:00Z" },
    );
    expect(
      await synchronizeCategories("owner", local, remote, reminders),
    ).toEqual([]);
    expect(
      (await local.list("owner")).find((item) => item.id === "work")?.deletedAt,
    ).not.toBeNull();
  });
});

describe("category-aware backups", () => {
  it.each(["all", "uncategorized"])(
    "remaps the built-in filter ID %s and its assignments",
    (id) => {
      const original = { ...fixture(), categoryId: id };
      const category = {
        ...starterCategories("owner", original.createdAt)[0]!,
        id,
        name: "Fitness",
      };
      const imported = importBackup(
        exportBackup([original], new Date(), [category]),
        [],
        "owner",
      );
      expect(imported.categories[0]?.id).toBe(`${id}-import-1`);
      expect(imported.merged[0]?.categoryId).toBe(`${id}-import-1`);
    },
  );
  it("round-trips assignments and remaps ID/name collisions without resurrecting deleted categories", () => {
    const original = fixture();
    const categories = starterCategories("owner", original.createdAt);
    const existing = [
      {
        ...categories[1]!,
        name: "Different",
        deletedAt: "2026-10-08T00:00:00Z",
      },
    ];
    const imported = importBackup(
      exportBackup([original], new Date(), categories),
      [],
      "other",
      existing,
    );
    expect(imported.invalid).toBe(0);
    expect(imported.merged[0]).toMatchObject({
      ownerId: "other",
      categoryId: "work-import-1",
    });
    expect(
      imported.categories.find((item) => item.id === "work-import-1"),
    ).toMatchObject({ ownerId: "other", name: "Work", revision: 1 });
    expect(
      imported.categories.find((item) => item.id === "work")?.deletedAt,
    ).not.toBeNull();
  });
  it("treats version-1 reminders as Uncategorized and rejects missing version-2 references", () => {
    const original = fixture();
    expect(
      importBackup(
        JSON.stringify({
          version: 1,
          exportedAt: original.createdAt,
          reminders: [original],
        }),
        [],
        "owner",
      ).merged[0]?.categoryId,
    ).toBeNull();
    expect(
      importBackup(exportBackup([original], new Date(), []), [], "owner")
        .invalid,
    ).toBe(1);
  });
});

describe("analytics repository", () => {
  it("reads beyond the default page limit without truncating counts", async () => {
    const daily = Array.from({ length: 1001 }, (_, index) => ({
      reminder_id: `r-${index}`,
      local_day: "2026-10-09",
      timezone: "UTC",
      completed: 1,
      postponed: 2,
    }));
    const offsets: number[] = [];
    const repository = new SupabaseAnalyticsRepository({
      rpc: async () => ({ data: null, error: null }),
      readPage: async (table, _owner, _order, offset, limit) => {
        if (table === "analytics_coverage")
          return {
            data: [{ available_since: "2026-09-01T00:00:00Z" }],
            error: null,
          };
        offsets.push(offset);
        return { data: daily.slice(offset, offset + limit), error: null };
      },
    });
    expect((await repository.load("owner")).days).toHaveLength(1001);
    expect(offsets).toEqual([0, 1000]);
  });
  it("surfaces storage errors instead of returning empty successful totals", async () => {
    const repository = new SupabaseAnalyticsRepository({
      rpc: async () => ({ data: null, error: { message: "offline" } }),
      readPage: async () => ({ data: [], error: null }),
    });
    await expect(repository.load("owner")).rejects.toMatchObject({
      message: "offline",
    });
  });
});
