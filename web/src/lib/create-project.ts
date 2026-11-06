import { customAlphabet } from "nanoid";

/**
 * Random suffixes for slugs and subdomains. Lowercase letters and digits
 * only: nanoid's default alphabet includes "-" and "_", which can leave a
 * subdomain ending in a hyphen or holding an underscore, and those aren't
 * valid hostnames, so the published site would be unreachable.
 */
export const hostSafeId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz");

/**
 * The readable part of a subdomain: at most 40 characters, so with the suffix
 * it stays under the 63-character hostname limit, and no "--" (reserved for
 * preview hosts) or hyphen at either end.
 */
export function hostLabel(text: string) {
  const clean = (s: string) => s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return clean(clean(text.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 40)) || "project";
}
import { db } from "./db";
import { initRepo, writeFiles, writeBinaryFile, commit } from "./repo";
import { scaffold } from "./scaffold";

/**
 * Create a project and its repository. New projects start from the scaffold
 * so they are a working app from the first second; imports bring their own
 * files instead.
 */
export async function createProject(opts: {
  workspaceId: string;
  userId: string;
  name: string;
  files?: { path: string; bytes: Buffer }[];
  message?: string;
}) {
  // One line, single spaces: names made from a pasted prompt carried line breaks into tab titles.
  const label = opts.name.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled project";
  const slug = hostLabel(label);

  const project = await db.project.create({
    data: {
      workspaceId: opts.workspaceId,
      createdById: opts.userId,
      name: label,
      slug: `${slug}-${hostSafeId(6)}`,
      subdomain: `${slug}-${hostSafeId(8)}`,
    },
  });

  await initRepo(project.id);
  if (opts.files?.length) {
    for (const f of opts.files) await writeBinaryFile(project.id, f.path, f.bytes);
  } else {
    await writeFiles(project.id, scaffold(label));
  }
  const sha = await commit(project.id, opts.message ?? "Initial scaffold");
  return db.project.update({ where: { id: project.id }, data: { headSha: sha } });
}

/** A project created from the same prompt very recently, to avoid duplicates. */
export async function findRecentDuplicate(workspaceId: string, name: string) {
  return db.project.findFirst({
    where: {
      workspaceId,
      deletedAt: null,
      name: name.trim().slice(0, 80),
      createdAt: { gt: new Date(Date.now() - 24 * 3_600_000) },
    },
    select: { id: true, name: true },
  });
}
