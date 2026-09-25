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
  void listener;
  return () => {};
}

export class DeviceNotificationAdapter implements NotificationPort {
  async requestPermission(): Promise<"granted" | "denied"> {
    if (!("Notification" in globalThis)) return "denied";
    return (await Notification.requestPermission()) === "granted"
      ? "granted"
      : "denied";
  }

  async register(ownerId: string): Promise<NotificationRegistration | null> {
    if (
      !("Notification" in globalThis) ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in globalThis)
    ) {
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
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(publicKey),
        }));
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
    const timeout = globalThis.setTimeout(() => {
      scheduledNotifications.delete(occurrence.id);
      new Notification(reminder.title, { body: reminder.notes });
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
