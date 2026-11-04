import { randomUUID } from "node:crypto";
import path from "node:path";
import { readAnnouncements, writeAnnouncements, type Announcement } from "./engagement";
import { PROJECTS_ROOT } from "./paths";

/**
 * Create, update, list and delete announcements in one file: Forge-wide ones
 * (platform admins) and a workspace's own banners for its members (workspace
 * owners and admins) share the same rules.
 */

export const workspaceAnnouncementsFile = (workspaceId: string) =>
  path.join(PROJECTS_ROOT, "_forge", "ws-announcements", `${workspaceId.replace(/[^\w-]/g, "")}.json`);

const iso = (v: unknown) => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function saveAnnouncement(b: Record<string, unknown>, file?: string) {
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 120) : "";
  const body = typeof b.body === "string" ? b.body.trim().slice(0, 500) : "";
  if (!title) return Response.json({ error: "Add a title." }, { status: 400 });
  const href = typeof b.href === "string" && b.href.trim() ? b.href.trim().slice(0, 500) : undefined;
  if (href && !/^(https?:\/\/|\/)/.test(href)) return Response.json({ error: "Links must start with https:// or /." }, { status: 400 });
  const startsAt = iso(b.startsAt);
  const endsAt = iso(b.endsAt);
  if (startsAt === null || endsAt === null) return Response.json({ error: "That date isn't valid." }, { status: 400 });
  if (startsAt && endsAt && endsAt <= startsAt) return Response.json({ error: "The end must be after the start." }, { status: 400 });

  const list = await readAnnouncements(file);
  const id = typeof b.id === "string" && list.some((a) => a.id === b.id) ? b.id : randomUUID();
  const item: Announcement = {
    id,
    title,
    body,
    href,
    startsAt: startsAt ?? new Date().toISOString(),
    endsAt,
    ...(b.countdown === true && endsAt ? { countdown: true } : {}),
  };
  const next = list.some((a) => a.id === id) ? list.map((a) => (a.id === id ? item : a)) : [item, ...list];
  await writeAnnouncements(next, file);
  return Response.json({ announcement: item }, { status: 201 });
}

export async function deleteAnnouncement(req: Request, file?: string) {
  const id = new URL(req.url).searchParams.get("id");
  const list = await readAnnouncements(file);
  if (!id || !list.some((a) => a.id === id)) return Response.json({ error: "Not found" }, { status: 404 });
  await writeAnnouncements(
    list.filter((a) => a.id !== id),
    file,
  );
  return Response.json({ ok: true });
}
