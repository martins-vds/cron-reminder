import type {
  CategoryConflict,
  CategoryRepository,
  ReminderRepository,
} from "@cron-reminder/application";
import {
  starterCategories,
  updateReminder,
  type ReminderCategory,
} from "@cron-reminder/domain";
import type { DatabaseClient } from "./databaseClient";
import type { KeyValueStore } from "./index";

interface CategoryState {
  categories: ReminderCategory[];
  synced: Record<string, number>;
}

export class JsonCategoryRepository implements CategoryRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: KeyValueStore) {}
  private key(ownerId: string) {
    return `cron-reminder:categories:${ownerId}`;
  }
  private async read(ownerId: string): Promise<CategoryState> {
    const value = await this.store.get(this.key(ownerId));
    return value
      ? (JSON.parse(value) as CategoryState)
      : { categories: [], synced: {} };
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async initialize(ownerId: string, portuguese = false): Promise<void> {
    await this.serialize(async () => {
      if (await this.store.get(this.key(ownerId))) return;
      await this.store.set(
        this.key(ownerId),
        JSON.stringify({
          categories: starterCategories(
            ownerId,
            new Date().toISOString(),
            portuguese,
          ),
          synced: {},
        }),
      );
    });
  }
  async list(ownerId: string): Promise<ReminderCategory[]> {
    await this.queue;
    return (await this.read(ownerId)).categories;
  }
  async save(category: ReminderCategory): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read(category.ownerId);
      state.categories = [
        ...state.categories.filter((item) => item.id !== category.id),
        category,
      ];
      await this.store.set(this.key(category.ownerId), JSON.stringify(state));
    });
  }
  async syncedRevision(
    ownerId: string,
    id: string,
  ): Promise<number | undefined> {
    await this.queue;
    return (await this.read(ownerId)).synced[id];
  }
  async acknowledge(category: ReminderCategory): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read(category.ownerId);
      state.synced[category.id] = category.revision;
      state.categories = [
        ...state.categories.filter((item) => item.id !== category.id),
        category,
      ];
      await this.store.set(this.key(category.ownerId), JSON.stringify(state));
    });
  }
  async clear(ownerId: string): Promise<void> {
    await this.serialize(async () => {
      if (!this.store.remove)
        throw new Error("Category storage cannot remove account data.");
      await this.store.remove(this.key(ownerId));
    });
  }
}

export class SupabaseCategoryRepository {
  constructor(private readonly client: DatabaseClient) {}
  async initialize(portuguese: boolean): Promise<void> {
    const { error } = await this.client.rpc("initialize_categories", {
      p_portuguese: portuguese,
    });
    if (error) throw error;
  }
  async list(ownerId: string): Promise<ReminderCategory[]> {
    const result: ReminderCategory[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.client.readPage(
        "reminder_categories",
        ownerId,
        ["id"],
        offset,
        1000,
      );
      if (error) throw error;
      for (const row of data ?? []) {
        if (
          typeof row.id !== "string" ||
          typeof row.owner_id !== "string" ||
          typeof row.name !== "string" ||
          typeof row.revision !== "number" ||
          typeof row.updated_at !== "string" ||
          (row.deleted_at !== null && typeof row.deleted_at !== "string")
        )
          throw new Error("Invalid category data.");
        result.push({
          id: row.id,
          ownerId: row.owner_id,
          name: row.name,
          revision: row.revision,
          updatedAt: new Date(row.updated_at).toISOString(),
          deletedAt: row.deleted_at
            ? new Date(row.deleted_at).toISOString()
            : null,
        });
      }
      if ((data?.length ?? 0) < 1000) return result;
    }
  }
  async save(
    category: ReminderCategory,
    expectedRevision?: number,
  ): Promise<void> {
    const { data, error } = await this.client.rpc("save_category", {
      p_id: category.id,
      p_name: category.name,
      p_revision: category.revision,
      p_expected_revision: expectedRevision ?? null,
      p_deleted: Boolean(category.deletedAt),
    });
    if (error) throw error;
    if (!data) throw new Error("categoryConcurrentEdit");
  }
}

export async function synchronizeCategories(
  ownerId: string,
  local: JsonCategoryRepository,
  remote: SupabaseCategoryRepository,
  reminders: ReminderRepository,
  portuguese = false,
): Promise<CategoryConflict[]> {
  await local.initialize(ownerId, portuguese);
  await remote.initialize(portuguese);
  const remoteCategories = await remote.list(ownerId);
  const localCategories = await local.list(ownerId);
  const conflicts: CategoryConflict[] = [];
  for (const server of remoteCategories) {
    const mine = localCategories.find((item) => item.id === server.id);
    const baseline = await local.syncedRevision(ownerId, server.id);
    if (
      !mine ||
      server.deletedAt ||
      mine.revision === baseline ||
      (mine.name === server.name &&
        mine.deletedAt === server.deletedAt &&
        mine.revision === server.revision)
    ) {
      await local.acknowledge(server);
    } else if (mine.deletedAt) {
      await remote.save(
        { ...mine, revision: Math.max(mine.revision, server.revision) + 1 },
        server.revision,
      );
    } else if (
      baseline === undefined &&
      mine.revision === 1 &&
      (mine.id === "personal" || mine.id === "work")
    ) {
      await local.acknowledge(server);
    } else if (server.revision !== baseline) {
      conflicts.push({ local: mine, remote: server });
    } else {
      await remote.save(mine, baseline ?? server.revision);
    }
  }
  for (const mine of localCategories) {
    if (!remoteCategories.some((item) => item.id === mine.id))
      await remote.save(mine);
  }
  const latest = await remote.list(ownerId);
  for (const server of latest) {
    if (!conflicts.some((item) => item.local.id === server.id))
      await local.acknowledge(server);
  }
  await clearDeletedCategoryAssignments(ownerId, local, reminders);
  return conflicts;
}

export async function clearDeletedCategoryAssignments(
  ownerId: string,
  categories: CategoryRepository,
  reminders: ReminderRepository,
): Promise<void> {
  const deleted = new Set(
    (await categories.list(ownerId))
      .filter((item) => item.deletedAt)
      .map((item) => item.id),
  );
  for (const reminder of await reminders.list(ownerId)) {
    if (reminder.categoryId && deleted.has(reminder.categoryId)) {
      await reminders.save(
        updateReminder(
          reminder,
          { categoryId: null },
          new Date().toISOString(),
        ),
      );
    }
  }
}
