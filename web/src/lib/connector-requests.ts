import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { open, seal, type SecretBox } from "./secret-box";
import { connect, ConnectorError, defFor } from "./connectors";

/**
 * Connector requests: when a workspace turns on "members need approval to
 * connect tools", a member's connect becomes a request for an admin in the
 * action center. The credential they entered is kept sealed with the request
 * and only used if an admin approves; a decline throws it away.
 */

export type ConnectorRequest = {
  id: string;
  userId: string;
  kind: string;
  name: string;
  label: string | null;
  scope: "workspace" | "project";
  projectId: string | null;
  reason: string | null;
  values: SecretBox;
  at: string;
};
type State = { approval: boolean; requests: ConnectorRequest[] };

const PURPOSE = "forge-connector-requests";
const file = (ws: string) => path.join(PROJECTS_ROOT, "_forge", "connector-requests", `${ws.replace(/[^\w-]/g, "")}.json`);

async function load(ws: string): Promise<State> {
  const raw = await fs.readFile(file(ws), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as State) : { approval: false, requests: [] };
}
async function save(ws: string, s: State) {
  await fs.mkdir(path.dirname(file(ws)), { recursive: true });
  await fs.writeFile(file(ws), JSON.stringify(s, null, 2));
}

export async function connectorApproval(ws: string) {
  return (await load(ws)).approval;
}
export async function setConnectorApproval(ws: string, on: boolean) {
  const s = await load(ws);
  await save(ws, { ...s, approval: on });
}

/** The pending requests, without the sealed credentials. */
export async function pendingConnectorRequests(ws: string) {
  return (await load(ws)).requests.map(({ values: _v, ...r }) => r);
}

export async function requestConnector(ws: string, userId: string, r: { kind: string; label?: string; values: Record<string, string>; scope: "workspace" | "project"; projectId?: string | null; reason?: string }) {
  const def = await defFor(ws, r.kind);
  if (!def) throw new ConnectorError("Unknown connector");
  for (const f of def.fields ?? []) if (!f.optional && !r.values[f.key]?.trim()) throw new ConnectorError(`${f.label} is required.`);
  const s = await load(ws);
  if (s.requests.some((x) => x.userId === userId && x.kind === r.kind && (x.label ?? "") === (r.label?.trim() ?? ""))) {
    throw new ConnectorError(`You already asked to connect ${def.name}. An admin will review it in the action center.`);
  }
  if (s.requests.filter((x) => x.userId === userId).length >= 10) throw new ConnectorError("You have 10 connector requests waiting. Wait for an admin to review them.");
  const req: ConnectorRequest = {
    id: `cr_${crypto.randomUUID()}`,
    userId,
    kind: def.kind,
    name: def.name,
    label: r.label?.trim().slice(0, 60) || null,
    scope: r.scope,
    projectId: r.scope === "project" ? (r.projectId ?? null) : null,
    reason: r.reason?.trim().slice(0, 300) || null,
    values: seal(PURPOSE, JSON.stringify(r.values)),
    at: new Date().toISOString(),
  };
  s.requests.push(req);
  await save(ws, s);
  const { values: _v, ...out } = req;
  return out;
}

/** Approve: connect with the member's sealed credential (checked as usual). Decline: drop it. */
export async function decideConnectorRequest(ws: string, id: string, approve: boolean) {
  const s = await load(ws);
  const req = s.requests.find((r) => r.id === id);
  if (!req) throw new ConnectorError("That request was already handled.");
  let connection: { id: string; label: string } | null = null;
  if (approve) {
    const c = await connect({ workspaceId: ws, kind: req.kind, label: req.label ?? undefined, values: JSON.parse(open(PURPOSE, req.values)) as Record<string, string>, scope: req.scope, projectId: req.projectId });
    connection = { id: c.id, label: c.label };
  }
  // Re-read: another request may have arrived while connecting.
  const now = await load(ws);
  await save(ws, { ...now, requests: now.requests.filter((r) => r.id !== id) });
  return { request: { ...req, values: undefined }, connection };
}
