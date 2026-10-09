import { describe, expect, it } from "vitest";
import {
  createReminder,
  starterCategories,
  validateCategoryName,
  type ReminderCategory,
} from "@cron-reminder/domain";
import { CategoryService, filterReminders, sameReminder } from "../src/index";

describe("reminder categories", () => {
  it("validates names and keeps built-in views reserved", () => {
    const categories = starterCategories("owner", "2026-10-09T00:00:00Z");
    expect(validateCategoryName("  Health  ", categories)).toBe("Health");
    expect(() => validateCategoryName(" WORK ", categories)).toThrow(
      "categoryNameDuplicate",
    );
    expect(() => validateCategoryName("", categories)).toThrow(
      "categoryNameRequired",
    );
    expect(() => validateCategoryName("Sem categoria", categories)).toThrow(
      "categoryNameReserved",
    );
    expect(validateCategoryName("Work", categories, "work")).toBe("Work");
  });
  it("composes category, status and text filtering and compares legacy null assignments equally", () => {
    const reminder = createReminder({
      id: "r",
      ownerId: "owner",
      title: "Task",
      tags: ["important"],
      schedule: { kind: "cron", expression: "* * * * *" },
      timezone: "UTC",
      now: "2026-10-09T00:00:00Z",
    });
    const work = { ...reminder, id: "work-r", categoryId: "work" };
    expect(
      filterReminders([reminder, work], {
        categoryId: "work",
        status: "active",
        query: "important",
      }),
    ).toEqual([work]);
    expect(filterReminders([reminder, work], { categoryId: null })).toEqual([
      reminder,
    ]);
    expect(sameReminder(reminder, { ...reminder, categoryId: undefined })).toBe(
      true,
    );
    expect(sameReminder(reminder, { ...reminder, categoryId: "work" })).toBe(
      false,
    );
  });
  it("advances revisions and retains deletion intent", async () => {
    let categories: ReminderCategory[] = [];
    const service = new CategoryService(
      {
        list: async (owner) =>
          categories.filter((item) => item.ownerId === owner),
        save: async (category) => {
          categories = [
            ...categories.filter((item) => item.id !== category.id),
            category,
          ];
        },
      },
      () => "2026-10-09T00:00:00Z",
      () => "category-health",
    );
    const created = await service.save("owner", "Health");
    expect(created.revision).toBe(1);
    await service.save("owner", "Exercise", created.id);
    await service.remove("owner", created.id);
    expect(categories[0]).toMatchObject({
      name: "Exercise",
      revision: 3,
      deletedAt: "2026-10-09T00:00:00Z",
    });
    await expect(service.save("owner", "Restore", created.id)).rejects.toThrow(
      "categoryNotFound",
    );
  });
});
