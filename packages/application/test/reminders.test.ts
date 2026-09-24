import { describe, expect, it } from "vitest";
import type { Reminder } from "@cron-reminder/domain";
import {
  ReminderService,
  detectConflict,
  filterReminders,
  sameReminder,
  type Clock,
  type ReminderRepository,
} from "../src/index";

class MemoryRepository implements ReminderRepository {
  readonly items = new Map<string, Reminder>();
  async list(ownerId: string): Promise<Reminder[]> {
    return [...this.items.values()].filter((item) => item.ownerId === ownerId);
  }
  async get(id: string): Promise<Reminder | null> {
    return this.items.get(id) ?? null;
  }
  async save(reminder: Reminder): Promise<void> {
    this.items.set(reminder.id, reminder);
  }
  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

const clock: Clock = { now: () => new Date("2026-09-23T12:00:00.000Z") };

describe("ReminderService", () => {
  it("creates, duplicates, disables, archives, restores, and permanently deletes", async () => {
    const repository = new MemoryRepository();
    let sequence = 0;
    const service = new ReminderService(
      repository,
      clock,
      () => `id-${++sequence}`,
    );
    const reminder = await service.create({
      ownerId: "user-1",
      title: "Pay rent",
      schedule: { kind: "cron", expression: "0 9 1 * *" },
      timezone: "America/Sao_Paulo",
    });
    const copy = await service.duplicate(reminder.id);
    expect(copy.title).toBe("Pay rent");
    expect((await service.setEnabled(reminder.id, false)).status).toBe(
      "disabled",
    );
    expect((await service.archive(reminder.id)).status).toBe("archived");
    expect((await service.restore(reminder.id)).status).toBe("active");
    await service.delete(reminder.id);
    expect(await repository.get(reminder.id)).toBeNull();
  });

  it("searches, filters, and sorts reminders", async () => {
    const repository = new MemoryRepository();
    const service = new ReminderService(repository, clock, () =>
      crypto.randomUUID(),
    );
    await service.create({
      ownerId: "user-1",
      title: "Water plants",
      notes: "Kitchen",
      tags: ["home"],
      schedule: { kind: "cron", expression: "0 8 * * *" },
      timezone: "UTC",
    });
    const result = filterReminders(await repository.list("user-1"), {
      query: "kitchen",
      tags: ["home"],
      status: "active",
      sort: "title",
    });
    expect(result.map(({ title }) => title)).toEqual(["Water plants"]);
  });

  it("detects concurrent revisions for manual resolution", () => {
    const base = {
      id: "r1",
      ownerId: "u1",
      title: "Original",
      notes: "",
      tags: [],
      schedule: { kind: "cron" as const, expression: "0 9 * * *" },
      timezone: "UTC",
      sound: { mode: "default" as const },
      status: "active" as const,
      revision: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(
      detectConflict({ ...base, title: "Local" }, { ...base, title: "Remote" }),
    ).toBe(true);
    expect(
      detectConflict(
        { ...base, title: "Local", revision: 2 },
        { ...base, title: "Remote", revision: 3 },
        1,
      ),
    ).toBe(true);
    expect(
      detectConflict(
        { ...base, title: "Local", revision: 2 },
        { ...base, revision: 1 },
        1,
      ),
    ).toBe(false);
    expect(detectConflict(base, base)).toBe(false);
    expect(
      sameReminder(base, {
        ...base,
        schedule: {
          expression: "0 9 * * *",
          kind: "cron",
        },
      }),
    ).toBe(true);
  });
});
