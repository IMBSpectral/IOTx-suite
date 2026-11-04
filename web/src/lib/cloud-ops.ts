import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import {
  CloudError,
  cloudDir,
  databaseSize,
  getCloud,
  listMigrations,
  listTables,
  proposeMigration,
  openDatabase,
  readSecret,
  reopenDatabase,
  updateCloud,
  type CloudConfig,
  type PauseReason,
} from "./cloud";
import { OUT_OF_CREDITS_GRACE_DAYS } from "./billing-cycle";
import { assertCredits, charge, creditsForUsage, InsufficientCredits, SpendLimitReached } from "./credits";
import { checkAiLimit, recordAiRun } from "./cloud-ai-log";
import { meteredFetch } from "./ai-meter";

/**
 * Running a Forge Cloud backend: health, pausing (after inactivity, by hand,
 * for credits or runaway traffic) and waking, AI for the app, the email
 * outbox, and a linter for the schema and access rules.
 */

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
export const IDLE_MS = num(process.env.CLOUD_IDLE_MS, 7 * 86_400_000);
export const TOGGLE_COOLDOWN_MS = num(process.env.CLOUD_TOGGLE_COOLDOWN_MS, 30_000);
const HIGH_LOAD_PER_MIN = num(process.env.CLOUD_HIGH_LOAD_PER_MIN, 300);
const EXCESSIVE_PER_MIN = num(process.env.CLOUD_EXCESSIVE_PER_MIN, 3000);
const AI_PER_MIN = num(process.env.CLOUD_AI_PER_MIN, 30);
const EMAILS_PER_HOUR = num(process.env.CLOUD_EMAILS_PER_HOUR, 20);
const DB_ATTENTION_BYTES = 500 * 1024 * 1024;
const TOUCH_EVERY_MS = 5 * 60_000;

export const PAUSE_TEXT: Record<PauseReason, string> = {
  inactivity: "Paused after a week without activity.",
  manual: "Paused by you.",
  out_of_credits: "Paused because the workspace is out of credits.",
  credit_limit: "Paused because the monthly spend limit was reached.",
  excessive_usage: "Paused because of unusually heavy traffic.",
};

// ── Traffic counters (per minute, last hour, in memory) ─────────

type Minute = { at: number; requests: number; errors: number };
const traffic = new Map<string, Minute[]>();

function minuteNow() {
  return Math.floor(Date.now() / 60_000);
}

export function recordRequest(projectId: string, ok: boolean) {
  const at = minuteNow();
  const list = traffic.get(projectId) ?? [];
  let m = list[list.length - 1];
  if (!m || m.at !== at) {
    m = { at, requests: 0, errors: 0 };
    list.push(m);
    while (list.length && list[0].at < at - 59) list.shift();
  }
  m.requests++;
  if (!ok) m.errors++;
  traffic.set(projectId, list);
  return m.requests;
}

function lastHour(projectId: string) {
  const since = minuteNow() - 59;
  const list = (traffic.get(projectId) ?? []).filter((m) => m.at >= since);
  const recent = list.filter((m) => m.at >= minuteNow() - 4);
  return {
    requests: list.reduce((n, m) => n + m.requests, 0),
    errors: list.reduce((n, m) => n + m.errors, 0),
    perMinute: Math.round(recent.reduce((n, m) => n + m.requests, 0) / 5),
  };
}

// ── Daily usage (persisted) ─────────────────────────────────────

type Day = { aiCalls: number; aiCredits: number; emails: number };
const usageFile = (projectId: string) => path.join(cloudDir(projectId), "usage.json");
const today = () => new Date().toISOString().slice(0, 10);

export async function readUsage(projectId: string): Promise<Record<string, Day>> {
  const raw = await fs.readFile(usageFile(projectId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Record<string, Day>) : {};
}

async function bumpUsage(projectId: string, patch: Partial<Day>) {
  const all = await readUsage(projectId);
  const d = (all[today()] ??= { aiCalls: 0, aiCredits: 0, emails: 0 });
  for (const [k, v] of Object.entries(patch) as [keyof Day, number][]) d[k] += v;
  // Keep a month of history.
  for (const day of Object.keys(all).sort().slice(0, -31)) delete all[day];
  await fs.writeFile(usageFile(projectId), JSON.stringify(all));
}

// ── Pause and wake ──────────────────────────────────────────────

export function isIdle(cfg: CloudConfig, now = Date.now()) {
  const last = Date.parse(cfg.lastActiveAt ?? cfg.enabledAt ?? "") || now;
  return now - last > IDLE_MS;
}

export async function pauseCloud(projectId: string, reason: PauseReason, byUser = false) {
  return updateCloud(projectId, (cfg) => {
    if (cfg.paused) {
      if (byUser) throw new CloudError("The backend is already paused.", 409);
      return;
    }
    // The cooldown is between a person's own pause and wake; an automatic pause can be woken straight away.
    if (byUser) {
      cooldown(cfg);
      cfg.toggledAt = new Date().toISOString();
    }
    cfg.paused = { reason, at: new Date().toISOString() };
  });
}

function cooldown(cfg: CloudConfig) {
  const since = Date.now() - (Date.parse(cfg.toggledAt ?? "") || 0);
  if (since < TOGGLE_COOLDOWN_MS) {
    throw new CloudError(`Wait ${Math.ceil((TOGGLE_COOLDOWN_MS - since) / 1000)} seconds before pausing or waking it again.`, 429);
  }
}

/** Wake a paused backend. A credit pause only lifts once there are credits again. */
export async function wakeCloud(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.paused) throw new CloudError("The backend isn't paused.", 409);
  if (cfg.paused.reason === "out_of_credits" || cfg.paused.reason === "credit_limit") {
    const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { workspaceId: true } });
    try {
      await assertCredits(p.workspaceId, { projectId });
    } catch (e) {
      if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) {
        throw new CloudError("Add credits or raise the spend limit before waking the backend.", 402);
      }
      throw e;
    }
  }
  return updateCloud(projectId, (c) => {
    cooldown(c);
    c.paused = null;
    c.toggledAt = new Date().toISOString();
    c.lastActiveAt = new Date().toISOString();
  });
}

/**
 * Every app request passes through here: a paused backend answers 503, an
 * idle one is paused (the app was away a week), runaway traffic pauses it,
 * and activity is recorded a few times an hour.
 */
export async function gate(projectId: string, cfg: CloudConfig) {
  if (!cfg.paused && isIdle(cfg)) {
    await pauseCloud(projectId, "inactivity");
    cfg.paused = { reason: "inactivity", at: new Date().toISOString() };
  }
  if (cfg.paused?.reason === "out_of_credits") {
    // Credits are back: the app comes back on its own.
    const p = await db.project.findUnique({ where: { id: projectId }, select: { workspace: { select: { creditBalance: true } } } });
    if ((p?.workspace.creditBalance ?? 0) > 0) {
      creditCheck.delete(projectId);
      await updateCloud(projectId, (c) => {
        c.paused = null;
      });
      cfg.paused = null;
    }
  } else if (!cfg.paused && (await outOfCreditsTooLong(projectId))) {
    await pauseCloud(projectId, "out_of_credits");
    cfg.paused = { reason: "out_of_credits", at: new Date().toISOString() };
  }
  if (cfg.paused) {
    throw new CloudError(`This app's backend is paused. ${PAUSE_TEXT[cfg.paused.reason]} Wake it up in ${getBrand().name}.`, 503);
  }
  const perMinute = recordRequest(projectId, true);
  if (perMinute > EXCESSIVE_PER_MIN) {
    await pauseCloud(projectId, "excessive_usage");
    throw new CloudError("This app's backend was paused because of unusually heavy traffic.", 503);
  }
  if (Date.now() - (Date.parse(cfg.lastActiveAt ?? "") || 0) > TOUCH_EVERY_MS) {
    await updateCloud(projectId, (c) => {
      c.lastActiveAt = new Date().toISOString();
    });
  }
}

const creditCheck = new Map<string, { at: number; over: boolean }>();

/** Whether the project's workspace has been out of credits past the grace period (checked once a minute). */
async function outOfCreditsTooLong(projectId: string) {
  const hit = creditCheck.get(projectId);
  if (hit && Date.now() - hit.at < 60_000) return hit.over;
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspace: { select: { outOfCreditsAt: true, creditBalance: true } } } });
  const since = p?.workspace.outOfCreditsAt;
  const over = !!since && (p?.workspace.creditBalance ?? 1) <= 0 && Date.now() - since.getTime() > OUT_OF_CREDITS_GRACE_DAYS * 86_400_000;
  creditCheck.set(projectId, { at: Date.now(), over });
  return over;
}

/** Count a failed app request (the success was counted in gate). */
export function recordError(projectId: string) {
  const list = traffic.get(projectId);
  const m = list?.[list.length - 1];
  if (m) {
    m.errors++;
    m.requests = Math.max(m.requests, 1);
  }
}

export async function restartCloud(projectId: string) {
  await reopenDatabase(projectId);
  traffic.delete(projectId);
}

// ── Health ──────────────────────────────────────────────────────

export async function cloudHealth(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  if (!cfg.paused && isIdle(cfg)) {
    await pauseCloud(projectId, "inactivity");
    cfg.paused = { reason: "inactivity", at: new Date().toISOString() };
  }
  const t = lastHour(projectId);
  const dbBytes = await databaseSize(projectId);
  const usage = (await readUsage(projectId))[today()] ?? { aiCalls: 0, aiCredits: 0, emails: 0 };
  const reasons: string[] = [];
  if (t.requests >= 10 && t.errors / t.requests > 0.2) reasons.push(`${Math.round((t.errors / t.requests) * 100)}% of requests failed in the last hour.`);
  if (dbBytes > DB_ATTENTION_BYTES) reasons.push("The database is over 500 MB.");
  const missing = cfg.requestedSecrets.filter((s) => !cfg.secrets[s.name]);
  if (missing.length) reasons.push(`The app is waiting for ${missing.map((s) => s.name).join(", ")}.`);
  const status = cfg.paused ? "paused" : reasons.length ? "needs_attention" : t.perMinute > HIGH_LOAD_PER_MIN ? "high_load" : "healthy";
  return {
    status,
    paused: cfg.paused ? { ...cfg.paused, text: PAUSE_TEXT[cfg.paused.reason] } : null,
    reasons,
    requestsLastHour: t.requests,
    errorsLastHour: t.errors,
    perMinute: t.perMinute,
    dbBytes,
    lastActiveAt: cfg.lastActiveAt ?? cfg.enabledAt,
    ai: { enabled: cfg.ai?.enabled !== false, callsToday: usage.aiCalls, creditsToday: usage.aiCredits },
    email: { enabled: cfg.email?.enabled !== false, sentToday: usage.emails, connected: !!cfg.secrets.RESEND_API_KEY, mailboxId: cfg.email?.mailboxId ?? null, senders: await (await import("./app-mail")).appSenderOptions(projectId) },
  };
}

// ── AI for the app ──────────────────────────────────────────────

const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const anthropic = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Cloud AI gateway") });
const MODELS = { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" } as const;
const aiMinute = new Map<string, { at: number; n: number }>();

export async function aiChat(projectId: string, cfg: CloudConfig, body: unknown) {
  if (cfg.ai?.enabled === false) throw new CloudError("AI is turned off for this app.", 403);
  const b = (body ?? {}) as { messages?: unknown; system?: unknown; model?: unknown; maxTokens?: unknown };
  const messages = Array.isArray(b.messages) ? b.messages : [];
  if (!messages.length || messages.length > 50) throw new CloudError("Send between 1 and 50 messages.");
  let total = 0;
  for (const m of messages as { role?: unknown; content?: unknown }[]) {
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) {
      throw new CloudError("Each message needs a role (user or assistant) and text content.");
    }
    total += m.content.length;
  }
  if ((messages[0] as { role: string }).role !== "user") throw new CloudError("The first message must be from the user.");
  if (total > 100_000) throw new CloudError("The conversation is too long.");
  const system = typeof b.system === "string" ? b.system.slice(0, 10_000) : undefined;
  const model = MODELS[b.model === "smart" ? "smart" : "fast"];
  const maxTokens = Math.min(4096, Math.max(16, Number(b.maxTokens) || 1024));

  const at = minuteNow();
  const rate = aiMinute.get(projectId);
  const n = rate?.at === at ? rate.n + 1 : 1;
  aiMinute.set(projectId, { at, n });
  if (n > AI_PER_MIN) throw new CloudError("Too many AI requests. Try again in a minute.", 429);

  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { workspaceId: true } });
  await checkAiLimit(projectId, cfg);
  try {
    await assertCredits(p.workspaceId, { projectId });
  } catch (e) {
    if (e instanceof InsufficientCredits) throw new CloudError("This app's AI is out of credits.", 402);
    if (e instanceof SpendLimitReached) throw new CloudError("This app's AI reached its spend limit.", 402);
    throw e;
  }

  const started = Date.now();
  const label = b.model === "smart" ? "smart" : "fast";
  let res: Anthropic.Message;
  try {
    res = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: messages as { role: "user" | "assistant"; content: string }[],
    });
  } catch (e) {
    await recordAiRun(
      projectId,
      cfg,
      { model: label, status: 502, ms: Date.now() - started, input_tokens: 0, output_tokens: 0, credits: 0, error: e instanceof Error ? e.message.slice(0, 500) : String(e) },
      { request: { system, messages }, response: null },
    );
    throw new CloudError("The AI model didn't answer. Try again.", 502);
  }
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const credits = creditsForUsage(res.usage.input_tokens, res.usage.output_tokens);
  await recordAiRun(
    projectId,
    cfg,
    { model: label, status: 200, ms: Date.now() - started, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, credits, error: null },
    { request: { system, messages }, response: text },
  );
  await charge(p.workspaceId, credits, "GENERATION", undefined, { category: "cloud", projectId });
  await bumpUsage(projectId, { aiCalls: 1, aiCredits: credits });
  return { text, model: b.model === "smart" ? "smart" : "fast", stopReason: res.stop_reason };
}

// ── Email ───────────────────────────────────────────────────────

export type OutboxEmail = {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  status: "captured" | "sent" | "failed";
  error?: string;
  at: string;
  by: string | null;
  from?: string;
  /** The provider's id, to ask for delivery status. */
  providerId?: string;
  /** The provider's latest event: delivered, bounced, complained, opened… */
  delivery?: string;
  deliveryAt?: string;
};
const outboxFile = (projectId: string) => path.join(cloudDir(projectId), "outbox.json");
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function readOutbox(projectId: string): Promise<OutboxEmail[]> {
  const raw = await fs.readFile(outboxFile(projectId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as OutboxEmail[]) : [];
}

/** Sends this hour against the app's hourly limit. */
export async function emailRate(projectId: string) {
  const hourAgo = Date.now() - 3_600_000;
  const recent = (await readOutbox(projectId)).filter((e) => Date.parse(e.at) > hourAgo);
  const oldest = recent.reduce((m, e) => Math.min(m, Date.parse(e.at)), Infinity);
  return { sentLastHour: recent.length, limit: EMAILS_PER_HOUR, resetsAt: recent.length >= EMAILS_PER_HOUR ? new Date(oldest + 3_600_000).toISOString() : null };
}

/** Ask the provider what happened to recent sent emails (delivered, bounced…). Final states aren't asked again. */
export async function refreshDeliveries(projectId: string) {
  const { deliveryStatus } = await import("./app-email-domain");
  const outbox = await readOutbox(projectId);
  const FINAL = new Set(["delivered", "bounced", "complained", "opened", "clicked", "failed"]);
  const due = outbox.filter((m) => m.providerId && !FINAL.has(m.delivery ?? "")).slice(0, 25);
  for (const m of due) {
    const ev = await deliveryStatus(projectId, m.providerId!).catch(() => null);
    if (ev) {
      m.delivery = ev;
      m.deliveryAt = new Date().toISOString();
    }
  }
  if (due.length) await fs.writeFile(outboxFile(projectId), JSON.stringify(outbox));
  return outbox;
}

/**
 * Send an email from the app. Only signed-in app users can send (so the
 * endpoint can't be used to spam strangers), within an hourly limit. With a
 * RESEND_API_KEY secret it really sends; otherwise it lands in the outbox.
 */
export async function sendEmail(projectId: string, cfg: CloudConfig, body: unknown, user: { id: string; email: string } | null) {
  if (cfg.email?.enabled === false) throw new CloudError("Email is turned off for this app.", 403);
  if (!user) throw new CloudError("Sign in to send email.", 401);
  const b = (body ?? {}) as { to?: unknown; subject?: unknown; text?: unknown; html?: unknown };
  const to = typeof b.to === "string" ? b.to.trim() : "";
  if (!EMAIL.test(to)) throw new CloudError("Give one valid email address in to.");
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (!subject || subject.length > 200) throw new CloudError("The subject must be 1–200 characters.");
  const text = typeof b.text === "string" ? b.text : "";
  const html = typeof b.html === "string" ? b.html : null;
  if (!text.trim() && !html) throw new CloudError("Add text or html.");
  if (text.length + (html?.length ?? 0) > 50_000) throw new CloudError("The email is too long.");

  const outbox = await readOutbox(projectId);
  const hourAgo = Date.now() - 3_600_000;
  if (outbox.filter((e) => Date.parse(e.at) > hourAgo).length >= EMAILS_PER_HOUR) {
    throw new CloudError("This app reached its email limit for the hour.", 429);
  }

  const mail = await deliver(projectId, cfg, { to, subject, text, html }, user.email, outbox);
  if (mail.status === "failed") throw new CloudError(mail.error ?? "Sending failed.", 502);
  return { id: mail.id, status: mail.status };
}

/**
 * Send (with a RESEND_API_KEY secret) or capture one email in the outbox.
 * Used by the app's own sends and by Forge's emails for the app (sign-in codes).
 */
export async function deliver(
  projectId: string,
  cfg: CloudConfig,
  m: { to: string; subject: string; text: string; html: string | null },
  by: string | null,
  outbox?: OutboxEmail[],
) {
  outbox ??= await readOutbox(projectId);
  const { to, subject, text, html } = m;
  const mail: OutboxEmail = { id: crypto.randomUUID(), to, subject, text, html, status: "captured", at: new Date().toISOString(), by };
  const key = await readSecret(projectId, "RESEND_API_KEY");
  if (cfg.email?.mailboxId) {
    // The company's own mailbox (Settings → Mailboxes), chosen in Cloud → Email.
    try {
      const { sendFromAppMailbox } = await import("./app-mail");
      await sendFromAppMailbox(projectId, cfg.email.mailboxId, { ...m, fromName: cfg.email.fromName });
      mail.status = "sent";
    } catch (e) {
      mail.status = "failed";
      mail.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
  } else if (key) {
    // From the app's verified domain when one is active (Cloud → Email → Sending domain).
    const { senderAddress, resendApi } = await import("./app-email-domain");
    const from = await senderAddress(projectId, cfg.email?.fromName ?? "App");
    mail.from = from;
    const res = await fetch(`${resendApi()}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, ...(html ? { html } : {}), ...(text ? { text } : {}) }),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message, json: async () => ({}) }) as const);
    mail.status = res.ok ? "sent" : "failed";
    if (res.ok) mail.providerId = String(((await res.json().catch(() => ({}))) as { id?: string }).id ?? "") || undefined;
    else mail.error = `Email provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
  }
  outbox.unshift(mail);
  await fs.writeFile(outboxFile(projectId), JSON.stringify(outbox.slice(0, 200)));
  await bumpUsage(projectId, { emails: 1 });
  return mail;
}

export async function setFeatures(projectId: string, patch: { ai?: boolean; email?: boolean; fromName?: string; mailboxId?: string | null }) {
  return updateCloud(projectId, (cfg) => {
    if (patch.ai !== undefined) cfg.ai = { enabled: patch.ai };
    if (patch.email !== undefined || patch.fromName !== undefined || patch.mailboxId !== undefined) {
      cfg.email = {
        enabled: patch.email ?? cfg.email?.enabled ?? true,
        fromName: (patch.fromName ?? cfg.email?.fromName ?? "App").trim().slice(0, 60) || "App",
        mailboxId: patch.mailboxId !== undefined ? patch.mailboxId : (cfg.email?.mailboxId ?? null),
      };
    }
  });
}

// ── Linter ──────────────────────────────────────────────────────

export type LintFinding = {
  id: string;
  severity: "error" | "warning" | "info";
  table?: string;
  title: string;
  detail: string;
  fix: string;
};

const SENSITIVE = /(password|passwd|secret|token|api_?key|ssn|card_?number)/i;

/** Reference columns (user_id, post_id…) that rows are looked up by but no index covers, in tables that have data. */
async function unindexedKeys(projectId: string, t: { name: string; rows: number; columns: { name: string; pk: number }[] }) {
  if (!t.rows) return [];
  const indexed = new Set(await openDatabase(projectId).indexedColumns(t.name));
  return t.columns.filter((c) => !c.pk && /(^|_)id$/i.test(c.name) && c.name !== "id" && !indexed.has(c.name)).map((c) => c.name);
}

/**
 * "Optimize database": one migration that adds the missing indexes, waiting
 * for the user's approval like any other schema change.
 */
export async function optimizeDatabase(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  const stmts: string[] = [];
  for (const t of await listTables(projectId)) {
    for (const col of await unindexedKeys(projectId, t)) {
      stmts.push(`CREATE INDEX IF NOT EXISTS "idx_${t.name}_${col}" ON "${t.name}" ("${col}");`);
    }
  }
  if (!stmts.length) return null;
  return proposeMigration(projectId, `Optimize database: add ${stmts.length} index${stmts.length === 1 ? "" : "es"}`, stmts.join("\n"));
}

export async function lintCloud(projectId: string): Promise<LintFinding[]> {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  const out: LintFinding[] = [];
  for (const t of await listTables(projectId)) {
    const cols = t.columns.map((c) => c.name);
    const explicit = !!cfg.policies[t.name];
    if (t.policy.read === "owner" || t.policy.write === "owner") {
      if (!cols.includes("user_id")) {
        out.push({
          id: `owner-no-user:${t.name}`,
          severity: "error",
          table: t.name,
          title: `${t.name} is owner-only but has no user_id column`,
          detail: "Owner access compares each row's user_id with the signed-in user, so nobody can read or change these rows.",
          fix: `Add a user_id TEXT column to ${t.name} with a migration, or change its access rule.`,
        });
      }
    }
    const leaky = cols.filter((c) => SENSITIVE.test(c));
    if (leaky.length && t.policy.read === "public") {
      out.push({
        id: `sensitive-public:${t.name}`,
        severity: "error",
        table: t.name,
        title: `${t.name} exposes ${leaky.join(", ")} to anyone`,
        detail: "The table can be read by anyone with the app's public key, and these columns look sensitive.",
        fix: `Make ${t.name} readable only by its owner or by signed-in users, or move ${leaky.join(", ")} out of it.`,
      });
    }
    if (!explicit) {
      out.push({
        id: `default-access:${t.name}`,
        severity: "warning",
        table: t.name,
        title: `${t.name} uses the default access rule`,
        detail: "Anyone can read it and any signed-in user can change any row. Fine for public content; not for personal data.",
        fix: `Set an explicit access rule for ${t.name} that matches who should see and change its rows.`,
      });
    }
    if (!t.columns.some((c) => c.pk)) {
      out.push({
        id: `no-pk:${t.name}`,
        severity: "warning",
        table: t.name,
        title: `${t.name} has no primary key`,
        detail: "Rows can't be updated or deleted reliably one at a time.",
        fix: `Recreate ${t.name} with an id primary key column.`,
      });
    }
    for (const col of await unindexedKeys(projectId, t)) {
      out.push({
        id: col === "user_id" ? `user-id-index:${t.name}` : `index:${t.name}.${col}`,
        severity: "info",
        table: t.name,
        title: `${t.name}.${col} has no index`,
        detail: "Looking up rows by it scans the whole table, which slows down as it grows.",
        fix: `Add an index on ${t.name}(${col}).`,
      });
    }
  }
  for (const s of cfg.requestedSecrets.filter((r) => !cfg.secrets[r.name])) {
    out.push({
      id: `secret-missing:${s.name}`,
      severity: "warning",
      title: `The secret ${s.name} hasn't been added`,
      detail: s.description || "The app asked for it and the features that use it won't work until it is set.",
      fix: `Add the ${s.name} secret in the Cloud tab.`,
    });
  }
  const pending = (await listMigrations(projectId)).filter((m) => m.status === "pending");
  if (pending.length) {
    out.push({
      id: "pending-migrations",
      severity: "info",
      title: `${pending.length} migration${pending.length === 1 ? " is" : "s are"} waiting for approval`,
      detail: pending.map((m) => m.description).join("; "),
      fix: "Review and approve or reject them in the Cloud tab.",
    });
  }
  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
