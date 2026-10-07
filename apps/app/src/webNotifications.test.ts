import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceNotificationAdapter,
  subscribeToPushTokenChanges,
} from "./notificationAdapter.web";

describe("browser notification registration", () => {
  const oldSubscription = {
    endpoint: "https://push.example/old",
    keys: { auth: "auth", p256dh: "key" },
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const newSubscription = {
    ...oldSubscription,
    endpoint: "https://push.example/new",
  };
  let windowEvents: EventTarget;
  let documentEvents: EventTarget;
  let notification: {
    permission: string;
    requestPermission: ReturnType<typeof vi.fn>;
  };
  let getSubscription: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;
  let getRegistration: ReturnType<typeof vi.fn>;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    oldSubscription.unsubscribe.mockReset().mockResolvedValue(true);
    windowEvents = new EventTarget();
    documentEvents = new EventTarget();
    notification = {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    };
    getSubscription = vi.fn().mockResolvedValue(oldSubscription);
    subscribe = vi.fn().mockResolvedValue(newSubscription);
    getRegistration = vi
      .fn()
      .mockResolvedValue({ pushManager: { getSubscription, subscribe } });
    vi.stubEnv("EXPO_PUBLIC_VAPID_PUBLIC_KEY", "AQID");
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration,
        register: vi.fn().mockResolvedValue(undefined),
        ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }),
      },
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener:
        documentEvents.removeEventListener.bind(documentEvents),
    });
    vi.stubGlobal(
      "addEventListener",
      windowEvents.addEventListener.bind(windowEvents),
    );
    vi.stubGlobal(
      "removeEventListener",
      windowEvents.removeEventListener.bind(windowEvents),
    );
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the actual current subscription without prompting for permission", async () => {
    expect(await new DeviceNotificationAdapter().currentToken()).toBe(
      JSON.stringify(oldSubscription),
    );
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it.each(["denied", "default"])(
    "does not claim registration or prompt when permission is %s",
    async (permission) => {
      notification.permission = permission;
      const listener = vi.fn();
      cleanups.push(subscribeToPushTokenChanges(listener));
      expect(await new DeviceNotificationAdapter().currentToken()).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      expect(notification.requestPermission).not.toHaveBeenCalled();
      expect(getRegistration).not.toHaveBeenCalled();
    },
  );

  it("refreshes this browser on focus, reconnect and becoming visible", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPushTokenChanges(listener);
    cleanups.push(unsubscribe);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenLastCalledWith(JSON.stringify(oldSubscription));
    getSubscription.mockResolvedValue(newSubscription);
    for (const event of ["focus", "online", "visibilitychange"]) {
      const expected = listener.mock.calls.length + 1;
      (event === "visibilitychange"
        ? documentEvents
        : windowEvents
      ).dispatchEvent(new Event(event));
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(expected));
      expect(listener).toHaveBeenLastCalledWith(
        JSON.stringify(newSubscription),
      );
    }
    unsubscribe();
    windowEvents.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(4);
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it("renews an expired subscription only when permission is already granted", async () => {
    getSubscription.mockResolvedValue(null);
    const listener = vi.fn();
    cleanups.push(subscribeToPushTokenChanges(listener));
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(JSON.stringify(newSubscription)),
    );
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it("replaces a provider-rejected subscription when registration is repaired", async () => {
    const registration = await new DeviceNotificationAdapter().register(
      "owner",
      true,
    );
    expect(oldSubscription.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(registration?.token).toBe(JSON.stringify(newSubscription));
  });

  it("reuses a retained subscription even when the push service cannot replace it", async () => {
    oldSubscription.unsubscribe.mockRejectedValue(
      new Error("Replacement unavailable"),
    );
    subscribe.mockRejectedValue(new Error("Replacement unavailable"));
    const registration = await new DeviceNotificationAdapter().register(
      "owner",
      false,
    );
    expect(registration?.token).toBe(JSON.stringify(oldSubscription));
    expect(oldSubscription.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe when this browser has never registered a service worker", async () => {
    getRegistration.mockResolvedValue(undefined);
    const listener = vi.fn();
    cleanups.push(subscribeToPushTokenChanges(listener));
    expect(await new DeviceNotificationAdapter().currentToken()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("surfaces subscription failures instead of reporting a healthy device", async () => {
    const failure = new Error("Push subscription lookup failed");
    getSubscription.mockRejectedValue(failure);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn();
    cleanups.push(subscribeToPushTokenChanges(listener));
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Unable to refresh browser push subscription",
        failure,
      ),
    );
    expect(listener).not.toHaveBeenCalled();
    await expect(
      new DeviceNotificationAdapter().currentToken(),
    ).rejects.toThrow(failure.message);
  });

  it("does not publish a subscription after its account listener was removed", async () => {
    let resolve: (value: typeof oldSubscription) => void = () => {};
    getSubscription.mockReturnValue(
      new Promise<typeof oldSubscription>((done) => {
        resolve = done;
      }),
    );
    const listener = vi.fn();
    const unsubscribe = subscribeToPushTokenChanges(listener);
    await vi.waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(1));
    unsubscribe();
    resolve(oldSubscription);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});
