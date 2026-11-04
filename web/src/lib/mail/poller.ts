import { db } from "../db";
import { syncFolder } from "./sync";

/**
 * Checks every working mailbox's inbox for new mail in the background
 * (FORGE_MAIL_POLL_MS, default 3 minutes), one mailbox at a time so a slow
 * server never holds up the rest.
 */
const G = globalThis as unknown as { __mailPoller?: NodeJS.Timeout; __mailPolling?: boolean };

async function tick() {
  if (G.__mailPolling) return;
  G.__mailPolling = true;
  try {
    const boxes = await db.mailbox.findMany({ where: { status: "ok" }, orderBy: { lastSyncAt: { sort: "asc", nulls: "first" } }, take: 50 });
    for (const m of boxes) await syncFolder(m, "INBOX").catch(() => undefined);
  } finally {
    G.__mailPolling = false;
  }
}

export function ensureMailPoller() {
  if (G.__mailPoller) return;
  const every = Number(process.env.FORGE_MAIL_POLL_MS ?? 180_000);
  G.__mailPoller = setInterval(() => void tick().catch(() => undefined), Math.max(30_000, every));
  G.__mailPoller.unref?.();
}
