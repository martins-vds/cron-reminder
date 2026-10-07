import type {
  NotificationPort,
  NotificationRegistration,
} from "@cron-reminder/application";
import type { Occurrence, Reminder } from "@cron-reminder/domain";
import { NotificationRegistrationError } from "./notificationErrors";

const scheduledNotifications = new Map<string, ReturnType<typeof setTimeout>>();

export function subscribeToPushTokenChanges(
  listener: (token: string) => void,
): () => void {
  let active = true;
  let refreshing = false;
  const refresh = async () => {
    if (
      !active ||
      refreshing ||
      !globalThis.isSecureContext ||
      !supportsWebPush() ||
      Notification.permission !== "granted"
    )
      return;
    refreshing = true;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;
      const subscription = await ensureSubscription(registration);
      if (active) listener(JSON.stringify(subscription));
    } catch (error) {
      console.error("Unable to refresh browser push subscription", error);
    } finally {
      refreshing = false;
    }
  };
  const retry = () => {
    void refresh();
  };
  const visible = () => {
    if (document.visibilityState === "visible") retry();
  };
  retry();
  globalThis.addEventListener("online", retry);
  globalThis.addEventListener("focus", retry);
  document.addEventListener("visibilitychange", visible);
  return () => {
    active = false;
    globalThis.removeEventListener("online", retry);
    globalThis.removeEventListener("focus", retry);
    document.removeEventListener("visibilitychange", visible);
  };
}

export class DeviceNotificationAdapter implements NotificationPort {
  async currentToken(): Promise<string | null> {
    if (
      !globalThis.isSecureContext ||
      !supportsWebPush() ||
      Notification.permission !== "granted"
    )
      return null;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? JSON.stringify(subscription) : null;
  }

  async requestPermission(): Promise<"granted" | "denied"> {
    if (!("Notification" in globalThis)) return "denied";
    return (await Notification.requestPermission()) === "granted"
      ? "granted"
      : "denied";
  }

  async register(
    ownerId: string,
    renew = false,
  ): Promise<NotificationRegistration | null> {
    if (!supportsWebPush()) {
      throw new NotificationRegistrationError("unsupported");
    }
    if (!globalThis.isSecureContext) {
      throw new NotificationRegistrationError("insecure-context");
    }
    if ((await this.requestPermission()) === "denied") return null;

    const publicKey = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) {
      throw new NotificationRegistrationError("missing-vapid-key");
    }

    try {
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await ensureSubscription(registration, renew);
      return {
        id: subscription.endpoint,
        ownerId,
        platform: "web",
        token: JSON.stringify(subscription),
      };
    } catch (error) {
      throw new NotificationRegistrationError("subscription-failed", {
        cause: error,
      });
    }
  }

  async schedule(reminder: Reminder, occurrence: Occurrence): Promise<void> {
    const delay = Date.parse(occurrence.scheduledAt) - Date.now();
    if (delay <= 0 || delay > 2_147_483_647) return;
    await this.cancel(occurrence.id);
    await navigator.serviceWorker.register("/sw.js");
    const registration = await navigator.serviceWorker.ready;
    const timeout = globalThis.setTimeout(() => {
      scheduledNotifications.delete(occurrence.id);
      const options: NotificationOptions & {
        actions: Array<{ action: string; title: string }>;
      } = {
        body: reminder.notes,
        data: {
          occurrenceId: occurrence.id,
          reminderId: reminder.id,
          ownerId: reminder.ownerId,
          soundMode: reminder.sound.mode,
        },
        silent: reminder.sound.mode === "silent",
        actions: [
          { action: "dismiss", title: "Dismiss" },
          { action: "snooze", title: "Postpone" },
          { action: "complete", title: "Complete" },
        ],
      };
      void registration
        .showNotification(reminder.title, options)
        .catch((error: unknown) =>
          console.error("Unable to show reminder notification", error),
        );
    }, delay);
    scheduledNotifications.set(occurrence.id, timeout);
  }

  async cancel(occurrenceId: string): Promise<void> {
    const timeout = scheduledNotifications.get(occurrenceId);
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    scheduledNotifications.delete(occurrenceId);
  }

  async showMissedSummary(count: number): Promise<void> {
    new Notification("Missed reminders", {
      body: `${count} reminders need your attention.`,
    });
  }
}

function supportsWebPush(): boolean {
  return (
    "Notification" in globalThis &&
    "navigator" in globalThis &&
    "serviceWorker" in navigator &&
    "PushManager" in globalThis
  );
}

async function ensureSubscription(
  registration: ServiceWorkerRegistration,
  renew = false,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing && !renew) return existing;
  const publicKey = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new NotificationRegistrationError("missing-vapid-key");
  if (existing && !(await existing.unsubscribe()))
    throw new Error("Unable to replace the expired browser subscription.");
  return await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeVapidKey(publicKey),
  });
}

function decodeVapidKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = globalThis.atob(
    (value + padding).replaceAll("-", "+").replaceAll("_", "/"),
  );
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++)
    bytes[index] = raw.charCodeAt(index);
  return bytes;
}
