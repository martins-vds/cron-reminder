// TypeScript fallback; Metro selects .native.ts or .web.ts for each target.
export {
  DeviceNotificationAdapter,
  subscribeToPushTokenChanges,
} from "./notificationAdapter.web";
