import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { acceptDraft, createDraft, discardDraft, draftBehind } from "./drafts";
import { ensureWorker } from "./worker";

/**
 * Variants: the same request built two or three ways, each in its own draft
 * from the accepted version, so they can be compared and one kept. Each
 * variant is asked for a distinctly different take. Choosing one accepts its
 * draft and discards the others.
 */

export type VariantGroup = {
  id: string;
  prompt: string;
  createdAt: string;
  drafts: string[];
  chosen: string | null;
  closedAt: string | null;
};

const file = (projectId: string) => path.join(PROJECTS_ROOT, "_variants", `${projectId}.json`);

async function readGroups(projectId: string): Promise<VariantGroup[]> {
  const raw = await fs.readFile(file(projectId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as VariantGroup[]) : [];
}
async function writeGroups(projectId: string, groups: VariantGroup[]) {
  await fs.mkdir(path.dirname(file(projectId)), { recursive: true });
  await fs.writeFile(file(projectId), JSON.stringify(groups.slice(-20), null, 2));
}

export class VariantError extends Error {}

const TAKES = [
  "Take the most straightforward approach.",
  "Take a distinctly different approach from the obvious one: a different layout, structure or visual direction.",
  "Take a bold, unexpected approach that still fully meets the request.",
];

export async function createVariants(projectId: string, userId: string, prompt: string, count: number) {
  const text = prompt.trim().slice(0, 4000);
  if (!text) throw new VariantError("Describe the change to make variants of.");
  const n = Math.min(3, Math.max(2, Math.round(count) || 3));
  const open = await db.draft.count({ where: { projectId, status: { in: ["BUILDING", "READY", "FAILED"] } } });
  if (open) throw new VariantError("Accept or discard the open draft first, so every variant starts from the same version.");
  if ((await readGroups(projectId)).some((g) => !g.closedAt)) throw new VariantError("Choose one of the current variants first.");

  const drafts: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await createDraft(projectId, userId, `Variant ${i + 1}: ${text.slice(0, 50)}`);
    // Each variant waits in its own draft until its turn runs.
    await db.draft.update({ where: { id: d.id }, data: { status: "READY" } });
    const content = `${text}\n\n(Variant ${i + 1} of ${n}. ${TAKES[i]})`;
    await db.message.create({ data: { projectId, userId, role: "USER", content, mode: "variant" } });
    const reply = await db.message.create({ data: { projectId, role: "ASSISTANT", content: "", mode: "variant" } });
    await db.build.create({ data: { projectId, messageId: reply.id, status: "QUEUED", mode: "build", draftId: d.id } });
    drafts.push(d.id);
  }
  const group: VariantGroup = { id: crypto.randomUUID(), prompt: text, createdAt: new Date().toISOString(), drafts, chosen: null, closedAt: null };
  const groups = await readGroups(projectId);
  groups.push(group);
  await writeGroups(projectId, groups);
  ensureWorker();
  return group;
}

/** The open group (if any) with each variant's state. */
export async function openVariants(projectId: string) {
  const g = (await readGroups(projectId)).find((x) => !x.closedAt);
  if (!g) return null;
  const drafts = await db.draft.findMany({ where: { id: { in: g.drafts } }, select: { id: true, status: true, headSha: true, branch: true } });
  const builds = await db.build.findMany({ where: { draftId: { in: g.drafts } }, select: { draftId: true, status: true } });
  return {
    ...g,
    variants: g.drafts.map((id, i) => {
      const d = drafts.find((x) => x.id === id);
      const b = builds.find((x) => x.draftId === id);
      const state = !d ? "gone" : b?.status === "QUEUED" ? "queued" : b?.status === "RUNNING" ? "building" : d.status === "FAILED" || b?.status === "FAILED" ? "failed" : "ready";
      return { id, n: i + 1, state, headSha: d?.headSha ?? null };
    }),
  };
}

/** Keep one variant: accept its draft (catching up first if needed), discard the rest. */
export async function chooseVariant(projectId: string, groupId: string, draftId: string) {
  const groups = await readGroups(projectId);
  const g = groups.find((x) => x.id === groupId && !x.closedAt);
  if (!g || !g.drafts.includes(draftId)) throw new VariantError("That variant isn't open.");
  const busy = await db.build.count({ where: { draftId: { in: g.drafts }, status: { in: ["QUEUED", "RUNNING"] } } });
  if (busy) throw new VariantError("Wait for every variant to finish building.");
  const draft = await db.draft.findUniqueOrThrow({ where: { id: draftId } });
  if (draft.status === "FAILED") throw new VariantError("This variant failed to build; pick another one.");
  for (const other of g.drafts.filter((d) => d !== draftId)) {
    await discardDraft(projectId, other).catch(() => undefined);
  }
  if (await draftBehind(projectId, draft)) throw new VariantError("The project changed since; update this variant first.");
  const accepted = await acceptDraft(projectId, draftId);
  g.chosen = draftId;
  g.closedAt = new Date().toISOString();
  await writeGroups(projectId, groups);
  return accepted;
}

/** Drop the whole set without keeping any. */
export async function discardVariants(projectId: string, groupId: string) {
  const groups = await readGroups(projectId);
  const g = groups.find((x) => x.id === groupId && !x.closedAt);
  if (!g) throw new VariantError("No open variants.");
  const busy = await db.build.count({ where: { draftId: { in: g.drafts }, status: { in: ["QUEUED", "RUNNING"] } } });
  if (busy) throw new VariantError("Wait for every variant to finish building.");
  for (const d of g.drafts) await discardDraft(projectId, d).catch(() => undefined);
  g.closedAt = new Date().toISOString();
  await writeGroups(projectId, groups);
}
