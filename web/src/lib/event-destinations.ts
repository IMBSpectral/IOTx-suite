import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { publicFetch } from "./net";

/**
 * Event destinations: a workspace's events (the audit trail: members,
 * sharing, publishing, connectors, security) sent to HTTPS endpoints as they
 * happen, signed with HMAC-SHA256. Check hooks go further: before an action
 * continues (publishing), Forge asks an endpoint, which can stop it.
 */

export type Destination = {
  id: string;
  url: string;
  events: string[]; // audit kinds, or ["*"]
  secret: string;
  enabled: boolean;
  createdAt: string;
  last?: { at: string; status: number | null; error?: string };
};
export type CheckHook = { id: string; url: string; action: "publish"; secret: string; onError: "allow" | "deny"; createdAt: string; last?: Destination["last"] };
type Store = { destinations: Destination[]; hooks: CheckHook[]; log: { at: string; to: string; event: string; status: number | null }[] };

export class EventError extends Error {}

const file = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "events", `${workspaceId.replace(/[^\w-]/g, "")}.json`);

async function load(workspaceId: string): Promise<Store> {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => null);
  return raw ? { destinations: [], hooks: [], log: [], ...(JSON.parse(raw) as Partial<Store>) } : { destinations: [], hooks: [], log: [] };
}
async function save(workspaceId: string, s: Store) {
  await fs.mkdir(path.dirname(file(workspaceId)), { recursive: true });
  await fs.writeFile(file(workspaceId), JSON.stringify(s, null, 2));
}

// Local testing only: lets endpoints on this machine receive events.
const allowLocal = process.env.FORGE_HOOKS_ALLOW_LOCAL === "1";
const isLoopback = (u: URL) => u.hostname === "localhost" || u.hostname === "127.0.0.1";

function checkUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EventError("Enter the endpoint's full address, starting with https://.");
  }
  if (u.protocol !== "https:" && !(allowLocal && isLoopback(u))) throw new EventError("Endpoints must use https://.");
  return u.toString();
}

function send(url: string, secret: string, body: string, timeoutMs: number) {
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "x-forge-timestamp": String(ts), "x-forge-signature": `sha256=${signature}`, "user-agent": "Forge-Webhooks/1.0" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  };
  const u = new URL(url);
  return allowLocal && isLoopback(u) ? fetch(u, init) : publicFetch(u, init, 0);
}

export async function listEvents(workspaceId: string) {
  const s = await load(workspaceId);
  // Secrets stay server-side after creation: only a hint is shown.
  const hide = <T extends { secret: string }>(x: T) => ({ ...x, secret: `${x.secret.slice(0, 6)}…` });
  return { destinations: s.destinations.map(hide), hooks: s.hooks.map(hide), log: s.log.slice(0, 50) };
}

export async function addDestination(workspaceId: string, input: { url?: string; events?: string[] }) {
  const s = await load(workspaceId);
  if (s.destinations.length >= 10) throw new EventError("A workspace can have 10 event destinations.");
  const events = (input.events ?? []).filter((e) => typeof e === "string" && /^[*a-z.]+$/.test(e));
  if (!events.length) throw new EventError("Pick which events to send.");
  const d: Destination = { id: crypto.randomUUID(), url: checkUrl(input.url ?? ""), events, secret: `whsec_${crypto.randomBytes(18).toString("base64url")}`, enabled: true, createdAt: new Date().toISOString() };
  s.destinations.push(d);
  await save(workspaceId, s);
  return d;
}

export async function addCheckHook(workspaceId: string, input: { url?: string; onError?: string }) {
  const s = await load(workspaceId);
  if (s.hooks.length >= 5) throw new EventError("A workspace can have 5 check hooks.");
  const h: CheckHook = {
    id: crypto.randomUUID(),
    url: checkUrl(input.url ?? ""),
    action: "publish",
    secret: `whsec_${crypto.randomBytes(18).toString("base64url")}`,
    onError: input.onError === "allow" ? "allow" : "deny",
    createdAt: new Date().toISOString(),
  };
  s.hooks.push(h);
  await save(workspaceId, s);
  return h;
}

export async function removeEndpoint(workspaceId: string, id: string) {
  const s = await load(workspaceId);
  s.destinations = s.destinations.filter((d) => d.id !== id);
  s.hooks = s.hooks.filter((h) => h.id !== id);
  await save(workspaceId, s);
}

export async function toggleDestination(workspaceId: string, id: string, enabled: boolean) {
  const s = await load(workspaceId);
  const d = s.destinations.find((x) => x.id === id);
  if (!d) throw new EventError("Destination not found.");
  d.enabled = enabled;
  await save(workspaceId, s);
}

// Writes to one workspace's store happen one at a time.
const chain = new Map<string, Promise<unknown>>();

/** Send one workspace event to every destination that wants it. Never throws. */
export function emitEvent(workspaceId: string, event: { kind: string; detail: string; actorId: string | null; projectId: string | null }) {
  const run = async () => {
    const s = await load(workspaceId);
    const targets = s.destinations.filter((d) => d.enabled && (d.events.includes("*") || d.events.includes(event.kind)));
    if (!targets.length) return;
    const body = JSON.stringify({ id: crypto.randomUUID(), type: event.kind, workspaceId, createdAt: new Date().toISOString(), data: event });
    for (const d of targets) {
      let status: number | null = null;
      let error: string | undefined;
      // One retry for a dropped connection or a 5xx.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await send(d.url, d.secret, body, 8000);
          status = r.status;
          error = undefined;
          if (r.status < 500) break;
        } catch (e) {
          error = e instanceof Error ? e.message.slice(0, 200) : String(e);
        }
      }
      d.last = { at: new Date().toISOString(), status, ...(error ? { error } : {}) };
      s.log.unshift({ at: d.last.at, to: d.url, event: event.kind, status });
    }
    s.log = s.log.slice(0, 100);
    await save(workspaceId, s);
  };
  const next = (chain.get(workspaceId) ?? Promise.resolve()).then(run).catch((e) => console.error("[events]", e));
  chain.set(workspaceId, next);
  return next;
}

/** Send a test event to one destination. */
export async function testDestination(workspaceId: string, id: string) {
  const s = await load(workspaceId);
  const d = s.destinations.find((x) => x.id === id) ?? s.hooks.find((x) => x.id === id);
  if (!d) throw new EventError("Endpoint not found.");
  const body = JSON.stringify({ id: crypto.randomUUID(), type: "test", workspaceId, createdAt: new Date().toISOString(), data: { message: `A test event from ${getBrand().name}` } });
  try {
    const r = await send(d.url, d.secret, body, 8000);
    return { status: r.status };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ask the workspace's check hooks whether an action may go ahead. A hook
 * answers {"allow": true} or {"allow": false, "reason": "..."}; an unreachable
 * hook follows its "if it can't be reached" setting.
 */
export async function runCheckHooks(workspaceId: string, action: "publish", payload: Record<string, unknown>) {
  const s = await load(workspaceId);
  const hooks = s.hooks.filter((h) => h.action === action);
  for (const h of hooks) {
    const body = JSON.stringify({ id: crypto.randomUUID(), type: `check.${action}`, workspaceId, createdAt: new Date().toISOString(), data: payload });
    let verdict: { allow: boolean; reason?: string };
    try {
      const r = await send(h.url, h.secret, body, 5000);
      const j = (await r.json().catch(() => null)) as { allow?: unknown; reason?: unknown } | null;
      verdict = r.ok && j && typeof j.allow === "boolean" ? { allow: j.allow, reason: typeof j.reason === "string" ? j.reason.slice(0, 300) : undefined } : { allow: h.onError === "allow", reason: `The check at ${new URL(h.url).host} answered ${r.status}.` };
      h.last = { at: new Date().toISOString(), status: r.status };
    } catch (e) {
      verdict = { allow: h.onError === "allow", reason: `The check at ${new URL(h.url).host} couldn't be reached.` };
      h.last = { at: new Date().toISOString(), status: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }
    await save(workspaceId, s).catch(() => undefined);
    if (!verdict.allow) return { allow: false, reason: verdict.reason ?? `Stopped by the check at ${new URL(h.url).host}.` };
  }
  return { allow: true };
}
