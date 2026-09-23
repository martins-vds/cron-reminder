import * as Notifications from "expo-notifications";
import type {
  NotificationPort,
  NotificationRegistration,
} from "@cron-reminder/application";
import type { Occurrence, Reminder } from "@cron-reminder/domain";
import { Platform } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export class DeviceNotificationAdapter implements NotificationPort {
  async requestPermission(): Promise<"granted" | "denied"> {
    const result = await Notifications.requestPermissionsAsync();
    return result.granted ? "granted" : "denied";
  }

  async register(ownerId: string): Promise<NotificationRegistration | null> {
    if ((await this.requestPermission()) === "denied") return null;
    await Notifications.setNotificationCategoryAsync("reminder", [
      { identifier: "dismiss", buttonTitle: "Dismiss" },
      { identifier: "snooze", buttonTitle: "Snooze" },
    ]);
    const token = await Notifications.getExpoPushTokenAsync();
    return {
      id: token.data,
      ownerId,
      platform: Platform.OS === "ios" ? "ios" : "android",
      token: token.data,
    };
  }

  async schedule(reminder: Reminder, occurrence: Occurrence): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      identifier: occurrence.id,
      content: {
        title: reminder.title,
        body: reminder.notes || undefined,
        sound: reminder.sound.mode === "silent" ? undefined : "default",
        categoryIdentifier: "reminder",
        data: { occurrenceId: occurrence.id, reminderId: reminder.id },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(occurrence.scheduledAt),
      },
    });
  }

  async cancel(occurrenceId: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(occurrenceId);
  }

  async showMissedSummary(count: number): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Missed reminders",
        body: `${count} reminders need your attention.`,
      },
      trigger: null,
    });
  }
}
