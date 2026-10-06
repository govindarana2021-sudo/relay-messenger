// Shows an "incoming call" notification even when Relay is closed, and brings the app back when tapped.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.from ? d.from + " is calling you" : "Relay", {
    body: "Tap to open Relay and answer the video call", tag: "relay-call", renotify: true, requireInteraction: true, icon: "/icon.svg"
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow("/");
  }));
});
