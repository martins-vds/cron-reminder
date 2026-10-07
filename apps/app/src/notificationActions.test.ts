/// <reference types="node" />
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(() => ({
  setNotificationHandler: vi.fn(),
  setNotificationCategoryAsync: vi.fn().mockResolvedValue(undefined),
  requestPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  getExpoPushTokenAsync: vi.fn().mockResolvedValue({ data: "expo-token" }),
  addPushTokenListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
}));

vi.mock("expo-notifications", () => notifications);
vi.mock("expo-constants", () => ({
  default: { easConfig: { projectId: "test-project" } },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Vibration: { vibrate: vi.fn() },
}));

import {
  DeviceNotificationAdapter,
  subscribeToPushTokenChanges,
} from "./notificationAdapter.native";

describe("notification actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers exactly dismiss, postpone, and complete on native devices", async () => {
    await new DeviceNotificationAdapter().register("owner");
    expect(notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      "reminder",
      [
        { identifier: "dismiss", buttonTitle: "Dismiss" },
        {
          identifier: "snooze",
          buttonTitle: "Postpone",
          options: { opensAppToForeground: true },
        },
        { identifier: "complete", buttonTitle: "Complete" },
      ],
    );
  });

  it("updates actions at startup for devices that are already registered", () => {
    const unsubscribe = subscribeToPushTokenChanges(vi.fn());
    expect(notifications.setNotificationCategoryAsync).toHaveBeenCalled();
    unsubscribe();
  });

  it("requests the same three actions for web push and relays completion", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    const cache = { put: vi.fn().mockResolvedValue(undefined) };
    runInNewContext(
      readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
      {
        self: {
          addEventListener: (
            type: string,
            callback: (event: unknown) => void,
          ) => listeners.set(type, callback),
          registration: { showNotification },
          location: { origin: "https://reminders.example" },
        },
        clients: {
          matchAll: vi
            .fn()
            .mockResolvedValue([{ postMessage, focus: vi.fn() }]),
        },
        caches: { open: vi.fn().mockResolvedValue(cache) },
        crypto: { randomUUID: () => "action-id" },
        Request,
        Response,
        URL,
      },
    );
    let work: Promise<void> | undefined;
    const waitUntil = (promise: Promise<void>) => {
      work = promise;
    };
    const data = { occurrenceId: "latest", ownerId: "owner" };
    listeners.get("push")!({
      data: { json: () => ({ title: "Reminder", data }) },
      waitUntil,
    });
    await work;
    expect(showNotification).toHaveBeenCalledWith(
      "Reminder",
      expect.objectContaining({
        actions: [
          { action: "dismiss", title: "Dismiss" },
          { action: "snooze", title: "Postpone" },
          { action: "complete", title: "Complete" },
        ],
      }),
    );
    listeners.get("notificationclick")!({
      notification: { close: vi.fn(), data },
      action: "complete",
      waitUntil,
    });
    await work;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "notification-action",
        action: "complete",
        occurrenceId: "latest",
        ownerId: "owner",
      }),
    );
    expect(cache.put).toHaveBeenCalled();
  });
});
