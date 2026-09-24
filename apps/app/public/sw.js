/* global self, clients */
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const soundMode = data.data?.soundMode;
  const vibration = [200, 100, 200];
  if (soundMode === "vibrate" && typeof self.navigator.vibrate === "function") {
    self.navigator.vibrate(vibration);
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Cron Reminder", {
      body: data.body,
      data: data.data,
      silent: soundMode === "silent" || soundMode === "vibrate",
      vibrate: soundMode === "vibrate" ? vibration : undefined,
      actions: [
        { action: "dismiss", title: "Dismiss" },
        { action: "snooze", title: "Snooze" },
      ],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const occurrenceId = encodeURIComponent(
    event.notification.data?.occurrenceId || "",
  );
  event.waitUntil(
    clients.openWindow(
      `/?action=${event.action || "open"}&occurrenceId=${occurrenceId}`,
    ),
  );
});
