export interface ReminderCategory {
  id: string;
  ownerId: string;
  name: string;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
}

const reservedNames = new Set([
  "all",
  "uncategorized",
  "todos",
  "sem categoria",
]);

export function categoryNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function validateCategoryName(
  name: string,
  categories: readonly ReminderCategory[],
  exceptId?: string,
): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("categoryNameRequired");
  const key = categoryNameKey(trimmed);
  if (reservedNames.has(key)) throw new Error("categoryNameReserved");
  if (
    categories.some(
      (item) =>
        !item.deletedAt &&
        item.id !== exceptId &&
        categoryNameKey(item.name) === key,
    )
  )
    throw new Error("categoryNameDuplicate");
  return trimmed;
}

export function starterCategories(
  ownerId: string,
  now: string,
  portuguese = false,
): ReminderCategory[] {
  return [
    { id: "personal", name: portuguese ? "Pessoal" : "Personal" },
    { id: "work", name: portuguese ? "Trabalho" : "Work" },
  ].map((item) => ({
    ...item,
    ownerId,
    revision: 1,
    updatedAt: now,
    deletedAt: null,
  }));
}
