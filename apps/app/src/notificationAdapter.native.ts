import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import type {
  NotificationPort,
  NotificationRegistration,
} from "@cron-reminder/application";
import type { Occurrence, Reminder } from "@cron-reminder/domain";
import { Platform, Vibration } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    if (notification.request.content.data?.soundMode === "vibrate") {
      Vibration.vibrate();
    }
    return {
      shouldPlaySound: notification.request.content.sound != null,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

const projectId =
  Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

function notificationChannelId(mode: Reminder["sound"]["mode"]): string {
  if (mode === "silent") return "reminders-silent";
  if (mode === "vibrate") return "reminders-vibrate";
  return "reminders-default";
}

async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Promise.all([
    Notifications.setNotificationChannelAsync("reminders-default", {
      name: "Reminders",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
    }),
    Notifications.setNotificationChannelAsync("reminders-vibrate", {
      name: "Vibrating reminders",
      importance: Notifications.AndroidImportance.HIGH,
      sound: null,
      vibrationPattern: [0, 250, 250, 250],
    }),
    Notifications.setNotificationChannelAsync("reminders-silent", {
      name: "Silent reminders",
      importance: Notifications.AndroidImportance.HIGH,
      sound: null,
      enableVibrate: false,
    }),
  ]);
}

export class DeviceNotificationAdapter implements NotificationPort {
  async requestPermission(): Promise<"granted" | "denied"> {
    await ensureAndroidChannels();
    const result = await Notifications.requestPermissionsAsync();
    return result.granted ? "granted" : "denied";
  }

  async register(ownerId: string): Promise<NotificationRegistration | null> {
    if ((await this.requestPermission()) === "denied") return null;
    await Notifications.setNotificationCategoryAsync("reminder", [
      { identifier: "dismiss", buttonTitle: "Dismiss" },
      { identifier: "snooze", buttonTitle: "Snooze" },
    ]);
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
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
        sound: reminder.sound.mode === "default" ? "default" : undefined,
        categoryIdentifier: "reminder",
        data: {
          occurrenceId: occurrence.id,
          reminderId: reminder.id,
          soundMode: reminder.sound.mode,
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(occurrence.scheduledAt),
        channelId: notificationChannelId(reminder.sound.mode),
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
