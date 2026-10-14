import { describe, expect, it } from "vitest";
import type { Task } from "@cron-reminder/domain";
import {
  TaskService,
  detectTaskConflict,
  filterTasks,
  sameTask,
  type Clock,
  type TaskRepository,
} from "../src/index";

class MemoryTaskRepository implements TaskRepository {
  readonly items = new Map<string, Task>();

  async list(ownerId: string): Promise<Task[]> {
    return [...this.items.values()].filter((item) => item.ownerId === ownerId);
  }
  async get(ownerId: string, id: string): Promise<Task | null> {
    const item = this.items.get(id);
    return item?.ownerId === ownerId ? item : null;
  }
  async save(task: Task): Promise<void> {
    this.items.set(task.id, task);
  }
  async delete(ownerId: string, id: string): Promise<void> {
    if (await this.get(ownerId, id)) this.items.delete(id);
  }
}

const clock: Clock = { now: () => new Date("2026-10-13T12:00:00.000Z") };

describe("TaskService", () => {
  it("creates, updates, completes, restores, archives, queries, and deletes", async () => {
    const repository = new MemoryTaskRepository();
    const service = new TaskService(repository, clock, () => "task-1");
    const task = await service.create({
      ownerId: "user-1",
      title: "Submit report",
      notes: "Finance",
      tags: ["work"],
      dueAt: "2026-10-15T17:00:00.000Z",
      reminderPolicy: {
        primary: { kind: "once", at: "2026-10-15T16:00:00.000Z" },
        overdue: { kind: "cron", expression: "0 * * * *" },
      },
      timezone: "UTC",
    });
    expect(
      (await service.update("user-1", task.id, { title: "Report" })).title,
    ).toBe("Report");
    expect((await service.complete("user-1", task.id)).status).toBe(
      "completed",
    );
    expect((await service.restore("user-1", task.id)).status).toBe("open");
    expect((await service.archive("user-1", task.id)).status).toBe("archived");
    expect(
      await service.query("user-1", {
        query: "finance",
        tags: ["work"],
        status: "archived",
      }),
    ).toHaveLength(1);
    await service.delete("user-1", task.id);
    expect(await repository.get("user-1", task.id)).toBeNull();
  });

  it("filters and sorts tasks by due date", () => {
    const first = task({ id: "first", dueAt: "2026-10-14T00:00:00.000Z" });
    const second = task({ id: "second", dueAt: "2026-10-16T00:00:00.000Z" });
    expect(filterTasks([second, first], {}).map(({ id }) => id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("detects concurrent task revisions and ignores timestamp formatting", () => {
    const local = task({ title: "Local", revision: 2 });
    const remote = task({ title: "Remote", revision: 2 });
    expect(detectTaskConflict(local, remote)).toBe(true);
    expect(detectTaskConflict(local, { ...local, revision: 1 }, 1)).toBe(false);
    expect(
      sameTask(local, {
        ...local,
        createdAt: "2026-10-13T08:00:00.000-04:00",
        updatedAt: "2026-10-13T08:00:00.000-04:00",
      }),
    ).toBe(true);
  });
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    ownerId: "user-1",
    title: "Submit report",
    notes: "",
    tags: [],
    categoryId: null,
    dueAt: "2026-10-15T17:00:00.000Z",
    reminderPolicy: {
      primary: { kind: "once", at: "2026-10-15T16:00:00.000Z" },
      overdue: { kind: "cron", expression: "0 * * * *" },
    },
    timezone: "UTC",
    status: "open",
    revision: 1,
    createdAt: "2026-10-13T12:00:00.000Z",
    updatedAt: "2026-10-13T12:00:00.000Z",
    ...overrides,
  };
}
