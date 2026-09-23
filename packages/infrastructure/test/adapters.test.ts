import { describe, expect, it } from "vitest";
import { createReminder, type Reminder } from "@cron-reminder/domain";
import {
  JsonReminderRepository,
  exportBackup,
  importBackup,
  type KeyValueStore,
} from "../src/index";

class MemoryStore implements KeyValueStore {
  value: string | null = null;
  async get(): Promise<string | null> {
    return this.value;
  }
  async set(_key: string, value: string): Promise<void> {
    this.value = value;
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
    const loaded = await repository.get(original.id);
    expect(loaded).toEqual(original);
    expect(loaded).not.toBe(original);
    await repository.delete(original.id);
    expect(await repository.get(original.id)).toBeNull();
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

  it("rejects malformed imports", () => {
    expect(() => importBackup('{"version":99}', [], "u1")).toThrow("backup");
  });
});
