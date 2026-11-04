"use client";

/** Browser calls to /workspace/api/meet/... Guests send their key in x-meet-guest. */
export class MeetError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown>) {
    super(message);
  }
}

const keyName = (code: string) => `iotx-meet-guest:${code}`;
export const guestKey = {
  get(code: string) {
    try {
      return sessionStorage.getItem(keyName(code));
    } catch {
      return null;
    }
  },
  set(code: string, k: string) {
    try {
      sessionStorage.setItem(keyName(code), k);
    } catch {}
  },
  clear(code: string) {
    try {
      sessionStorage.removeItem(keyName(code));
    } catch {}
  },
};

export async function meetApi<T = any>(path: string, init: { method?: string; body?: unknown; guest?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.guest) headers["x-meet-guest"] = init.guest;
  const r = await fetch(`/workspace/api/meet${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new MeetError(r.status, String(d.error ?? `Request failed (${r.status})`), d);
  return d as T;
}

export type JoinReply =
  | { status: "waiting"; participantId: string; key?: string; ended?: boolean }
  | {
      status: "admitted";
      token: string;
      url: string;
      identity: string;
      role: "host" | "cohost" | "member" | "guest" | "panelist" | "attendee";
      name: string;
      key?: string;
      settings: { waitingRoom: boolean; allowGuests: boolean; muteOnEntry: boolean; locked: boolean; everyoneWaits?: boolean; hasPasscode?: boolean; captions?: boolean; captionLang?: string; kind?: string; e2ee?: boolean };
      dialIn?: DialIn | null;
    };

/** Phone dial-in (only when LiveKit SIP is set up on the server). */
export type DialIn = { numbers: string[]; meetingId: string; pin: string; oneTap: string[] };

export type MeetingInfo = {
  code: string;
  title: string;
  host: string;
  ended: boolean;
  locked: boolean;
  waitingRoom: boolean;
  allowGuests: boolean;
  muteOnEntry: boolean;
  everyoneWaits?: boolean;
  passcode?: boolean;
  personal?: boolean;
  kind?: "meeting" | "webinar";
  e2ee?: boolean;
  e2eeCheck?: string | null;
  startsAt?: string | null;
  registration?: boolean;
  you: { kind: "member"; name: string; host: boolean; coHost?: boolean; panelist?: boolean } | null;
};

export function initials(name: string) {
  return (
    name
      .replace(/[^\p{L}\p{N}\s@._-]/gu, "")
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("") || "?"
  );
}
const PALETTE = ["#4f46e5", "#0891b2", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#0d9488"];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
