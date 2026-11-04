import type { Boot } from "@/lib/page";

export type Person = Boot["people"][number];
export type Presence = "active" | "away" | "dnd";
export type PresenceMap = Record<string, { presence: Presence; status: string; emoji: string }>;

export type Channel = {
  id: string; kind: "public" | "private" | "dm"; name: string; topic: string; description: string; createdBy: string;
  joined: boolean; memberIds: string[]; unread: number; mentions: number; lastReadAt: string | null;
  muted: boolean; notifyLevel: "all" | "mentions" | "none"; starred: boolean; retentionDays: number | null;
  dmWith: string | null; dmWithAll: string[];
};

export type ChatFile = { id: string; name: string; type: string; size: number };
export type Preview = { url: string; title: string; description: string; image: string; site: string };

export type Msg = {
  id: string; channelId: string; userId: string; parentId: string | null; body: string; deleted: boolean; editedAt: string | null; createdAt: string;
  mentions: string[]; pinned: boolean; replyCount: number; lastReplyAt: string | null; taskId: string | null;
  reactions: { emoji: string; users: string[] }[];
  alsoChannel: boolean; broadcast: string | null; system: boolean;
  files: ChatFile[]; preview: Preview | null; shared: (Msg & { channelName?: string; channelKind?: string }) | null; sharedId: string | null;
  hookId: string | null; hookName: string | null; app?: boolean;
  channelName?: string; channelKind?: string;
};

export type Group = { id: string; handle: string; name: string; memberIds: string[]; createdBy: string };
export type Prefs = { status?: string; emoji?: string; until?: string | null; away?: boolean; dndUntil?: string | null; email?: boolean; desktop?: boolean; push?: boolean; presence?: Presence };

export const fileUrl = (id: string, download = false) => `/workspace/api/chat/files/${id}${download ? "?download=1" : ""}`;
export const msgLink = (m: Pick<Msg, "id" | "channelId" | "parentId">) =>
  `${typeof window !== "undefined" ? window.location.origin : ""}/workspace/chat?channel=${m.channelId}${m.parentId ? `&thread=${m.parentId}` : ""}&message=${m.id}`;

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtTime = (d: string | Date) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export function fmtDay(d: string | Date) {
  const x = new Date(d);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (x.toDateString() === today.toDateString()) return "Today";
  if (x.toDateString() === y.toDateString()) return "Yesterday";
  return x.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", ...(x.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** "In 20 minutes", "Tomorrow 9:00", … for reminders and scheduled sends. */
export function laterOptions(now = new Date()) {
  const at = (h: number, m = 0, days = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const monday = (() => {
    const d = at(9, 0, ((8 - now.getDay()) % 7) || 7);
    return d;
  })();
  return [
    { label: "In 20 minutes", at: new Date(now.getTime() + 20 * 60_000) },
    { label: "In 1 hour", at: new Date(now.getTime() + 3600_000) },
    { label: "In 3 hours", at: new Date(now.getTime() + 3 * 3600_000) },
    { label: "Tomorrow at 9:00", at: at(9, 0, 1) },
    { label: "Next Monday at 9:00", at: monday },
  ];
}

/** yyyy-MM-ddTHH:mm for <input type="datetime-local">. */
export const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Guests ("guest_…") and apps (bots "bot_…", workflows "wf_…") get a small badge. */
export const isGuestId = (id: string) => id.startsWith("guest_");
export const isAppId = (id: string) => id.startsWith("bot_") || id.startsWith("wf_");
