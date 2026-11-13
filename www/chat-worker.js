self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data;
  const role = data?.role === "coach" ? "coach" : "athlete";
  const page = role === "coach" && data?.destination === "calendar" ? "calendar"
    : role === "athlete" && data?.destination === "workout" ? "workout" : "chat";
  const clientId = role === "coach" && page === "chat" && /^[\da-f-]{36}$/i.test(data?.clientId) ? data.clientId : "";
  const destination = new URL(role + ".html#" + page + (clientId ? "/" + clientId : ""), self.registration.scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows.find(client => new URL(client.url).pathname === destination.pathname);
    if (target) {
      await target.focus();
      target.postMessage({ type: "open-notification", destination: page, clientId });
    } else {
      await self.clients.openWindow(destination.href);
    }
  })());
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
