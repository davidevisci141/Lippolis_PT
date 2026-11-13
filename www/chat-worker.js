self.addEventListener("notificationclick", event => {
  event.notification.close();
  const role = event.notification.data?.role === "coach" ? "coach" : "athlete";
  const destination = new URL(role + ".html#chat", self.registration.scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows.find(client => new URL(client.url).pathname === destination.pathname);
    if (target) {
      await target.focus();
      target.postMessage({ type: "open-chat" });
    } else {
      await self.clients.openWindow(destination.href);
    }
  })());
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
