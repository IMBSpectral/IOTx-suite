import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { getBrand } from "./brand";
import { PROJECTS_ROOT } from "./paths";
import { listSkills, personalOwner } from "./skills";

/**
 * "Features tried": a checklist of what Forge can do, ticked from what the
 * person has actually done in this workspace, with a prompt to try each
 * remaining one on a project of their choice.
 */

export type Feature = { id: string; label: string; tried: boolean; prompt: string | null; href: string | null };

export async function featuresTried(userId: string, workspaceId: string): Promise<{ features: Feature[]; lastProject: { id: string; name: string } | null }> {
  const projects = await db.project.findMany({
    where: { workspaceId, deletedAt: null, kind: "app" },
    select: { id: true, name: true, publishedSha: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  const ids = projects.map((p) => p.id);
  const [builds, plans, members, connectors, automations] = await Promise.all([
    db.build.count({ where: { projectId: { in: ids }, status: "SUCCEEDED", mode: "build" } }),
    db.message.count({ where: { projectId: { in: ids }, userId, mode: "plan" } }),
    db.membership.count({ where: { workspaceId } }),
    db.connector.count({ where: { workspaceId } }),
    db.automation.count({ where: { workspaceId } }).catch(() => 0),
  ]);
  const cloud = (await Promise.all(ids.slice(0, 20).map((id) => fs.stat(path.join(PROJECTS_ROOT, "_cloud", id, "config.json")).then(() => true, () => false)))).some(Boolean);
  const skills = (await listSkills(workspaceId)).length + (await listSkills(personalOwner(userId))).length;
  const features: Feature[] = [
    { id: "build", label: "Build an app by describing it", tried: builds > 0, prompt: null, href: "/dashboard" },
    { id: "plan", label: "Plan before building (Plan mode)", tried: plans > 0, prompt: null, href: null },
    { id: "cloud", label: `Add a database and sign-in (${getBrand().shortName} Cloud)`, tried: cloud, prompt: "Add user accounts with sign-in, and save each user's data in the database so it's there next time.", href: null },
    { id: "publish", label: "Publish an app", tried: projects.some((p) => !!p.publishedSha), prompt: null, href: null },
    { id: "team", label: "Invite a teammate", tried: members > 1, prompt: null, href: "/settings/members" },
    { id: "connector", label: "Connect a tool (Notion, Stripe, GitHub…)", tried: connectors > 0, prompt: null, href: "/settings/connectors" },
    { id: "skill", label: "Save a skill to reuse", tried: skills > 0, prompt: null, href: "/settings/skills" },
    { id: "automation", label: "Schedule an automation", tried: automations > 0, prompt: null, href: "/automations" },
  ];
  const last = projects[0] ?? null;
  return { features, lastProject: last ? { id: last.id, name: last.name } : null };
}
