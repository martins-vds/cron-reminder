import {
  validateCategoryName,
  type ReminderCategory,
} from "@cron-reminder/domain";

export interface CategoryRepository {
  list(ownerId: string): Promise<ReminderCategory[]>;
  save(category: ReminderCategory): Promise<void>;
}

export interface CategoryConflict {
  local: ReminderCategory;
  remote: ReminderCategory;
}

export class CategoryService {
  constructor(
    private readonly repository: CategoryRepository,
    private readonly now: () => string,
    private readonly createId: () => string,
  ) {}

  async save(
    ownerId: string,
    name: string,
    id?: string,
  ): Promise<ReminderCategory> {
    const categories = await this.repository.list(ownerId);
    const existing = id ? categories.find((item) => item.id === id) : undefined;
    if (id && (!existing || existing.deletedAt))
      throw new Error("categoryNotFound");
    const category: ReminderCategory = {
      id: existing?.id ?? this.createId(),
      ownerId,
      name: validateCategoryName(name, categories, id),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: this.now(),
      deletedAt: null,
    };
    await this.repository.save(category);
    return category;
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const category = (await this.repository.list(ownerId)).find(
      (item) => item.id === id,
    );
    if (!category || category.deletedAt) throw new Error("categoryNotFound");
    const now = this.now();
    await this.repository.save({
      ...category,
      deletedAt: now,
      updatedAt: now,
      revision: category.revision + 1,
    });
  }
}
