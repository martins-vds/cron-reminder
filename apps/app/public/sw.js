/* global self, clients */
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Cron Reminder", {
      body: data.body,
      data: data.data,
      actions: [
        { action: "dismiss", title: "Dismiss" },
        { action: "snooze", title: "Snooze" },
      ],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(`/?action=${event.action || "open"}`));
});
