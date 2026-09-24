/* global self, clients, caches, crypto, Request, URL, Response */
const actionCacheName = "cron-reminder-actions-v1";
const actionPathPrefix = "/__cron-reminder-action__/";

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
      silent: soundMode === "silent",
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
  const data = event.notification.data || {};
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windows) => {
        const action = {
          type: "notification-action",
          action: event.action || "open",
          occurrenceId: data.occurrenceId,
          ownerId: data.ownerId,
        };
        const client = windows[0];
        if (client) {
          client.postMessage(action);
          if ("focus" in client) await client.focus();
          return;
        }
        const cache = await caches.open(actionCacheName);
        const key = `${actionPathPrefix}${Date.now()}-${crypto.randomUUID()}`;
        await cache.put(
          new Request(new URL(key, self.location.origin)),
          new Response(JSON.stringify(action), {
            headers: { "Content-Type": "application/json" },
          }),
        );
        await clients.openWindow("/");
      }),
  );
});
