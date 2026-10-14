import {
  archiveTask,
  completeTask,
  createTask,
  restoreTask,
  updateTask,
  type CreateTaskInput,
  type Task,
  type UpdateTaskChanges,
} from "@cron-reminder/domain";
import type { Clock } from "./index";
import { structurallyEqual } from "./index";

export interface TaskRepository {
  list(ownerId: string): Promise<Task[]>;
  get(ownerId: string, id: string): Promise<Task | null>;
  save(task: Task): Promise<void>;
  delete(ownerId: string, id: string): Promise<void>;
  listDeletedIds?(ownerId: string): Promise<string[]>;
  getSyncedRevision?(ownerId: string, id: string): Promise<number | null>;
  setSyncedRevision?(
    ownerId: string,
    id: string,
    revision: number,
  ): Promise<void>;
}

export interface TaskQuery {
  query?: string;
  tags?: readonly string[];
  status?: Task["status"] | "all";
  sort?: "due" | "title" | "status" | "updated";
  categoryId?: string | null;
}

export interface TaskQueryPort {
  query(ownerId: string, query: TaskQuery): Promise<Task[]>;
}

export interface TaskSyncConflict {
  id: string;
  local: Task;
  remote: Task;
}

export interface TaskSynchronizationPort {
  synchronize(ownerId: string): Promise<readonly TaskSyncConflict[]>;
  resolve(conflict: TaskSyncConflict, resolution: Task): Promise<void>;
}

export interface TaskConflictPort {
  detect(local: Task, remote: Task, syncedRevision?: number): boolean;
  resolve(conflict: TaskSyncConflict, resolution: Task): Promise<void>;
}

export type CreateTaskCommand = Omit<CreateTaskInput, "id" | "now">;

export class TaskService implements TaskQueryPort {
  constructor(
    private readonly repository: TaskRepository,
    private readonly clock: Clock,
    private readonly createId: () => string,
  ) {}

  async create(command: CreateTaskCommand): Promise<Task> {
    const task = createTask({
      ...command,
      id: this.createId(),
      now: this.clock.now().toISOString(),
    });
    await this.repository.save(task);
    return task;
  }

  async update(
    ownerId: string,
    id: string,
    changes: UpdateTaskChanges,
  ): Promise<Task> {
    return this.save(
      updateTask(
        await this.require(ownerId, id),
        changes,
        this.clock.now().toISOString(),
      ),
    );
  }

  async complete(ownerId: string, id: string): Promise<Task> {
    return this.save(
      completeTask(
        await this.require(ownerId, id),
        this.clock.now().toISOString(),
      ),
    );
  }

  async archive(ownerId: string, id: string): Promise<Task> {
    return this.save(
      archiveTask(
        await this.require(ownerId, id),
        this.clock.now().toISOString(),
      ),
    );
  }

  async restore(ownerId: string, id: string): Promise<Task> {
    return this.save(
      restoreTask(
        await this.require(ownerId, id),
        this.clock.now().toISOString(),
      ),
    );
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.require(ownerId, id);
    await this.repository.delete(ownerId, id);
  }

  async query(ownerId: string, query: TaskQuery): Promise<Task[]> {
    return filterTasks(await this.repository.list(ownerId), query);
  }

  private async save(task: Task): Promise<Task> {
    await this.repository.save(task);
    return task;
  }

  private async require(ownerId: string, id: string): Promise<Task> {
    const task = await this.repository.get(ownerId, id);
    if (!task) throw new Error("Task not found.");
    return task;
  }
}

export function filterTasks(tasks: readonly Task[], query: TaskQuery): Task[] {
  const needle = query.query?.trim().toLocaleLowerCase();
  const tags = query.tags ?? [];
  const result = tasks.filter((task) => {
    const searchable =
      `${task.title} ${task.notes} ${task.tags.join(" ")}`.toLocaleLowerCase();
    return (
      (!needle || searchable.includes(needle)) &&
      (query.categoryId === undefined ||
        (task.categoryId ?? null) === query.categoryId) &&
      (!query.status ||
        query.status === "all" ||
        task.status === query.status) &&
      tags.every((tag) => task.tags.includes(tag))
    );
  });
  const sort = query.sort ?? "due";
  return result.sort((left, right) => {
    if (sort === "title") return left.title.localeCompare(right.title);
    if (sort === "status") return left.status.localeCompare(right.status);
    if (sort === "updated")
      return right.updatedAt.localeCompare(left.updatedAt);
    return (
      left.dueAt.localeCompare(right.dueAt) ||
      left.title.localeCompare(right.title)
    );
  });
}

export function detectTaskConflict(
  local: Task,
  remote: Task,
  syncedRevision?: number,
): boolean {
  if (local.id !== remote.id || sameTask(local, remote)) return false;
  if (syncedRevision === undefined) return true;
  const localChanged = local.revision !== syncedRevision;
  const remoteChanged = remote.revision !== syncedRevision;
  return (localChanged && remoteChanged) || (!localChanged && !remoteChanged);
}

export function sameTask(left: Task, right: Task): boolean {
  return structurallyEqual(
    comparableTaskContent(left),
    comparableTaskContent(right),
  );
}

function comparableTaskContent(
  task: Task,
): Omit<Task, "createdAt" | "updatedAt"> {
  return {
    id: task.id,
    ownerId: task.ownerId,
    title: task.title,
    notes: task.notes,
    tags: task.tags,
    categoryId: task.categoryId ?? null,
    dueAt: task.dueAt,
    reminderPolicy: task.reminderPolicy,
    timezone: task.timezone,
    status: task.status,
    revision: task.revision,
  };
}
