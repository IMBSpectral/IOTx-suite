import { db } from "./db";

/**
 * What each plan can publish. The free plan publishes with the "Edit with
 * Forge" badge on its own subdomain; paid plans can hide the badge and use
 * custom domains.
 */
export type Entitlements = { hideBadge: boolean; customDomain: boolean; plan: string };

export function entitlementsFor(plan: string): Entitlements {
  const paid = plan !== "FREE";
  return { hideBadge: paid, customDomain: paid, plan };
}

export async function projectEntitlements(projectId: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { workspace: { select: { plan: true } } } });
  return entitlementsFor(p.workspace.plan);
}
