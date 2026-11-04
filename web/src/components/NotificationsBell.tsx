"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { TabLink } from "./iotx/tabs";

type Item = { id: string; kind: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string };

/** Inbox in the sidebar: publish requests, access requests and the like. */
/** align: which edge the list lines up with ("right" for a bell near the right of the screen). */
export default function NotificationsBell({ align = "left" }: { align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);

  const fetchInbox = useCallback(
    () =>
      fetch("/api/notifications")
        .then((r) => (r.ok ? r.json() : { items: [], unread: 0 }))
        .catch(() => ({ items: [], unread: 0 })),
    [],
  );

  useEffect(() => {
    let live = true;
    const tick = () =>
      fetchInbox().then((d) => {
        if (!live) return;
        setItems(d.items);
        setUnread(d.unread);
      });
    void tick();
    const t = setInterval(tick, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [fetchInbox]);

  async function markAll() {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    setUnread(0);
    setItems((all) => all.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        className="relative grid h-8 w-8 place-items-center rounded-lg hover:bg-black/[.05] dark:hover:bg-white/[.06]"
      >
        <Bell className="h-4 w-4" style={{ color: "var(--muted)" }} />
        {unread > 0 && (
          <span
            className="absolute right-0.5 top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-[#6d4aff] px-[3px] text-[9px] font-semibold leading-none text-white"
            style={{ boxShadow: "0 0 0 2px var(--shell)" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-50 mt-2 w-80 max-w-[calc(100vw-24px)] rounded-xl border shadow-xl`}
          style={{ background: "var(--panel)", color: "var(--text)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-[11px] hover:underline" style={{ color: "var(--muted)" }}>
                Mark all as read
              </button>
            )}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items.length === 0 && (
              <li className="px-3 py-6 text-center text-xs" style={{ color: "var(--muted)" }}>
                You&apos;re all caught up.
              </li>
            )}
            {items.map((n) => {
              // Opens in the current suite tab (Ctrl/middle click: a new one), Workspace pages included.
              return (
              <li key={n.id} className={`border-b last:border-0 ${n.readAt ? "" : "bg-[#6d4aff]/[.04]"}`}>
                <TabLink
                  href={n.href ?? "/home"}
                  onClick={() => {
                    setOpen(false);
                    if (!n.readAt) void fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [n.id] }) }).catch(() => {});
                  }}
                  className="block px-3 py-2 hover:bg-black/[.03]"
                >
                  <p className="text-sm">{n.title}</p>
                  {n.body && (
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      {n.body}
                    </p>
                  )}
                  <p className="mt-0.5 text-[10px]" style={{ color: "var(--muted)" }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                </TabLink>
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
