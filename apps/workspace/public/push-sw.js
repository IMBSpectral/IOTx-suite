/* IOTx Workspace push notifications: shows pushes from the server and opens their link when clicked. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: e.data ? e.data.text() : "IOTx" };
  }
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/workspace/chat";
  e.waitUntil(
    self.registration.showNotification(d.title || "IOTx", {
      body: d.body || "",
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: "/workspace/push-icon.svg",
      badge: "/workspace/push-icon.svg",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : "/workspace/chat", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin + "/workspace") && "navigate" in c) return c.focus().then(() => c.navigate(url));
      }
      return self.clients.openWindow(url);
    }),
  );
});
