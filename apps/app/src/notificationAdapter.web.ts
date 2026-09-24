import type {
  NotificationPort,
  NotificationRegistration,
} from "@cron-reminder/application";
import type { Occurrence, Reminder } from "@cron-reminder/domain";

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
      (await this.requestPermission()) === "denied" ||
      !("serviceWorker" in navigator)
    )
      return null;
    const registration = await navigator.serviceWorker.register("/sw.js");
    const publicKey = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (publicKey
        ? await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeVapidKey(publicKey),
          })
        : null);
    return subscription
      ? {
          id: subscription.endpoint,
          ownerId,
          platform: "web",
          token: JSON.stringify(subscription),
        }
      : null;
  }

  async schedule(reminder: Reminder, occurrence: Occurrence): Promise<void> {
    const delay = Date.parse(occurrence.scheduledAt) - Date.now();
    if (delay <= 0 || delay > 2_147_483_647) return;
    globalThis.setTimeout(
      () => new Notification(reminder.title, { body: reminder.notes }),
      delay,
    );
  }

  async cancel(): Promise<void> {}

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
