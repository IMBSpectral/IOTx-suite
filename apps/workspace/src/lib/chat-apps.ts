import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Channel, ChatBot, ChatWorkflow, Message } from "@prisma/client";
import { db } from "./db";
import { publish } from "./bus";
import { HttpError, type Me } from "./auth";
import { bad, str } from "./http";
import { isAdmin, isAppId, isGuest, loadChannel, postMessage, republish } from "./chat";
import { createTask } from "./tasks";
import { privateIp, safeLookup } from "./unfurl";

/**
 * Chat apps: bots and workflows.
 *
 * Bots are workspace members ("bot_…") made by admins. They post with their
 * API token (/api/chat/bot/…), can be added to channels and messaged, get
 * signed events at their URL for people's messages in their channels and DMs
 * (a reply { text } is posted back), and own custom slash commands (the
 * reply is shown to everyone or only to the sender; response_url works for
 * 30 minutes). Every request is signed: x-iotx-signature = "v0=" +
 * HMAC-SHA256(secret, "v0:<x-iotx-timestamp>:<body>").
 *
 * Workflows are no-code: one trigger (someone joins a channel, a keyword, a
 * reaction, a schedule, or a shortcut with a form) and up to 10 steps (post
 * a message, send a DM, create a task, add a reaction). They post as
 * "wf_<id>" under their own name. Only people's actions trigger them, never
 * apps', so they can't loop.
 *
 * Outbound calls only go to public addresses (checked at connect time, no
 * redirects); CHAT_OUTBOUND_ALLOW lists host:port pairs allowed anyway, for
 * local tests.
 */

// ── Outbound ───────────────────────────────────────────────────────────────

const allowed = () => (process.env.CHAT_OUTBOUND_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function urlOk(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  if (allowed().includes(u.host)) return true;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || (net.isIP(host) && privateIp(host))) return false;
  return true;
}

export const sign = (secret: string, ts: string, body: string) => `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

/** POST JSON to an app's URL, signed; the JSON reply (≤ 64 KB) or null. Never throws. */
export function callApp(url: string, secret: string, payload: unknown, timeout = 3000): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
  if (!urlOk(url)) return Promise.resolve(null);
  const u = new URL(url);
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        timeout,
        ...(allowed().includes(u.host) ? {} : { lookup: safeLookup }),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "IOTxChat/1.0", "x-iotx-timestamp": ts, "x-iotx-signature": sign(secret, ts, body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 64 * 1024) return res.destroy();
          chunks.push(c);
        });
        res.on("close", () => {
          let json: Record<string, unknown> | null = null;
          try {
            const t = Buffer.concat(chunks).toString("utf8").trim();
            if (t.startsWith("{")) json = JSON.parse(t);
            else if (t) json = { text: t };
          } catch {}
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

// ── Bots ───────────────────────────────────────────────────────────────────

type Command = { command: string; description: string; usage: string };
const RESERVED_COMMANDS = ["topic", "invite", "leave", "mute", "remind", "away", "active", "dnd", "status", "catchup", "shrug", "me", "msg", "dm", "join", "help"];

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const cmdName = (s: unknown) => String(s ?? "").toLowerCase().replace(/^\//, "").replace(/[^a-z0-9_-]/g, "").slice(0, 32);

function cleanCommands(raw: unknown, ws: string, others: ChatBot[]): Command[] {
  const list = Array.isArray(raw) ? raw.slice(0, 20) : [];
  const out: Command[] = [];
  for (const c of list as Record<string, unknown>[]) {
    const command = cmdName(c?.command);
    if (!command) continue;
    if (RESERVED_COMMANDS.includes(command)) bad(`/${command} is a built-in command.`);
    if (out.some((o) => o.command === command) || others.some((b) => b.ws === ws && (b.commands as Command[]).some((o) => o.command === command))) bad(`/${command} is already used by another bot.`);
    out.push({ command, description: str(c?.description, 120), usage: str(c?.usage, 80) });
  }
  return out;
}

function botDto(b: ChatBot) {
  return { id: b.id, userId: b.userId, name: b.name, description: b.description, eventsUrl: b.eventsUrl, commands: b.commands as Command[], createdBy: b.createdBy, createdAt: b.createdAt, disabled: !!b.disabledAt };
}

const adminOnly = (me: Me) => {
  if (!isAdmin(me)) throw new HttpError(403, "Only Chat admins can manage bots.");
};

export async function listBots(me: Me) {
  const rows = await db.chatBot.findMany({ where: { ws: me.ws }, orderBy: { createdAt: "asc" } });
  return rows.map(botDto);
}

export async function createBot(me: Me, b: { name?: string; description?: string; eventsUrl?: string; commands?: unknown }) {
  adminOnly(me);
  const name = str(b.name, 60);
  if (!name) bad("Give the bot a name.");
  const eventsUrl = str(b.eventsUrl, 500);
  if (eventsUrl && !urlOk(eventsUrl)) bad("The bot's URL must be a public http(s) address.");
  if ((await db.chatBot.count({ where: { ws: me.ws } })) >= 50) bad("A workspace can have up to 50 bots.");
  const commands = cleanCommands(b.commands, me.ws, await db.chatBot.findMany({ where: { ws: me.ws } }));
  const token = `xbot-${crypto.randomBytes(24).toString("base64url")}`;
  const secret = crypto.randomBytes(24).toString("hex");
  const userId = `bot_${crypto.randomBytes(9).toString("base64url")}`;
  await db.user.create({ data: { id: userId, email: "", name } });
  await db.member.create({ data: { ws: me.ws, userId } });
  const bot = await db.chatBot.create({ data: { ws: me.ws, userId, name, description: str(b.description, 300), tokenHash: hash(token), secret, eventsUrl, commands, createdBy: me.userId } });
  publish(`ws:${me.ws}`, { type: "apps" });
  // The token and signing secret are shown once.
  return { bot: botDto(bot), token, secret };
}

export async function updateBot(me: Me, id: string, b: { name?: string; description?: string; eventsUrl?: string; commands?: unknown; disabled?: boolean; rotate?: boolean }) {
  adminOnly(me);
  const bot = await db.chatBot.findUnique({ where: { id } });
  if (!bot || bot.ws !== me.ws) throw new HttpError(404, "Bot not found");
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const name = str(b.name, 60);
    if (!name) bad("Give the bot a name.");
    data.name = name;
    await db.user.update({ where: { id: bot.userId }, data: { name } });
  }
  if (b.description !== undefined) data.description = str(b.description, 300);
  if (b.eventsUrl !== undefined) {
    const u = str(b.eventsUrl, 500);
    if (u && !urlOk(u)) bad("The bot's URL must be a public http(s) address.");
    data.eventsUrl = u;
  }
  if (b.commands !== undefined) data.commands = cleanCommands(b.commands, me.ws, await db.chatBot.findMany({ where: { ws: me.ws, id: { not: id } } }));
  if (b.disabled !== undefined) data.disabledAt = b.disabled ? new Date() : null;
  let token: string | undefined;
  if (b.rotate) {
    token = `xbot-${crypto.randomBytes(24).toString("base64url")}`;
    data.tokenHash = hash(token);
  }
  const u = await db.chatBot.update({ where: { id }, data });
  publish(`ws:${me.ws}`, { type: "apps" });
  return { bot: botDto(u), ...(token ? { token } : {}) };
}

export async function deleteBot(me: Me, id: string) {
  adminOnly(me);
  const bot = await db.chatBot.findUnique({ where: { id } });
  if (!bot || bot.ws !== me.ws) throw new HttpError(404, "Bot not found");
  await db.chatBot.delete({ where: { id } });
  await db.channelMember.deleteMany({ where: { userId: bot.userId } });
  await db.member.deleteMany({ where: { ws: me.ws, userId: bot.userId } });
  // The user row stays so old messages keep the bot's name.
  publish(`ws:${me.ws}`, { type: "apps" });
  return { ok: true };
}

/** The bot behind an API request's "Authorization: Bearer xbot-…", as a Me that can only use Chat. */
export async function botMe(req: Request): Promise<{ me: Me; bot: ChatBot }> {
  const token = /^Bearer\s+(xbot-[\w-]{20,})$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "Send the bot token as Authorization: Bearer xbot-…");
  const bot = await db.chatBot.findFirst({ where: { tokenHash: hash(token) } });
  if (!bot || bot.disabledAt) throw new HttpError(401, "That bot token isn't valid.");
  const me: Me = { sid: "bot", userId: bot.userId, ws: bot.ws, name: bot.name, email: "", tz: "UTC", owner: false, perms: { "teamchat.open": true }, stale: false, guest: false };
  return { me, bot };
}

/** Bots post only where they are members (or in DMs with them). */
export async function botChannel(me: Me, channelId: string) {
  const { ch, member } = await loadChannel(me, channelId);
  if (!member) throw new HttpError(403, "Add the bot to this channel first (/invite @bot or Channel details → Members).");
  return ch;
}

async function botEvent(bot: ChatBot, me: Me, ch: Channel, msg: Message, mentioned: boolean) {
  const r = await callApp(bot.eventsUrl, bot.secret, {
    type: "event",
    event: {
      type: mentioned ? "app_mention" : "message",
      channel: ch.id, channelName: ch.kind === "dm" ? null : ch.name, channelType: ch.kind,
      user: me.userId, userName: me.name, text: msg.body, message: msg.id, thread: msg.parentId,
    },
    workspace: ch.ws,
    bot: bot.userId,
  });
  const text = typeof r?.json?.text === "string" ? r.json.text.trim() : "";
  if (!text || r!.status >= 300) return;
  const botAsMe: Me = { sid: "bot", userId: bot.userId, ws: bot.ws, name: bot.name, email: "", tz: "UTC", owner: false, perms: { "teamchat.open": true }, stale: false, guest: false };
  // A reply goes in the thread when the message was in one (or the bot asks for it).
  const inThread = !!msg.parentId || r!.json!.thread === true;
  await postMessage(botAsMe, ch.id, { body: text, parentId: inThread ? msg.parentId ?? msg.id : undefined });
}

// ── Slash commands ─────────────────────────────────────────────────────────

type Pending = { botId: string; channelId: string; userId: string; ws: string; parentId: string | null; until: number };
const g = globalThis as unknown as { __chatRespond?: Map<string, Pending> };
const pending = g.__chatRespond ?? (g.__chatRespond = new Map());

export async function listCommands(me: Me) {
  const bots = await db.chatBot.findMany({ where: { ws: me.ws, disabledAt: null } });
  return bots.flatMap((b) => (b.commands as Command[]).map((c) => ({ ...c, bot: b.name, botId: b.id })));
}

async function answer(p: Pending, text: string, inChannel: boolean) {
  const bot = await db.chatBot.findUnique({ where: { id: p.botId } });
  if (!bot || !text) return null;
  if (!inChannel) {
    // Only the person who ran the command sees it.
    publish(`user:${p.userId}`, { type: "ephemeral", channelId: p.channelId, text, from: bot.name });
    return { ephemeral: text };
  }
  const botAsMe: Me = { sid: "bot", userId: bot.userId, ws: bot.ws, name: bot.name, email: "", tz: "UTC", owner: false, perms: { "teamchat.open": true }, stale: false, guest: false };
  const m = await postMessage(botAsMe, p.channelId, { body: text, parentId: p.parentId ?? undefined }, { asApp: true });
  return { message: m };
}

/** "/deploy staging" in a channel: ask the bot that owns /deploy. */
export async function runCommand(me: Me, channelId: string, command: string, text: string, parentId?: string) {
  const { ch, member } = await loadChannel(me, channelId);
  if (!member) bad("Join the channel to use commands in it.");
  if (ch.archivedAt) bad("This channel is archived.");
  const name = cmdName(command);
  const bot = (await db.chatBot.findMany({ where: { ws: me.ws, disabledAt: null } })).find((b) => (b.commands as Command[]).some((c) => c.command === name));
  if (!bot) bad(`/${name} isn't a command here. Type / to see the list.`);
  if (!bot.eventsUrl) bad(`/${name} has no URL to send to yet.`);
  const token = crypto.randomBytes(18).toString("base64url");
  const p: Pending = { botId: bot.id, channelId: ch.id, userId: me.userId, ws: me.ws, parentId: parentId ?? null, until: Date.now() + 30 * 60_000 };
  pending.set(token, p);
  for (const [k, v] of pending) if (v.until < Date.now()) pending.delete(k);
  const base = (process.env.PUBLIC_ORIGIN || process.env.WORKSPACE_PUBLIC_URL || "http://localhost:3100").replace(/\/$/, "");
  const r = await callApp(bot.eventsUrl, bot.secret, {
    type: "slash_command", command: `/${name}`, text: text.slice(0, 2000),
    user: me.userId, userName: me.name, channel: ch.id, channelName: ch.kind === "dm" ? null : ch.name, thread: parentId ?? null,
    response_url: `${base}/workspace/api/chat/bot/respond/${token}`,
  });
  if (!r) return { ephemeral: `/${name} didn't answer. Try again in a moment.` };
  if (r.status >= 300) return { ephemeral: `/${name} failed (${r.status}).` };
  const reply = typeof r.json?.text === "string" ? r.json.text.trim().slice(0, 12000) : "";
  if (!reply) return { ok: true };
  return (await answer(p, reply, r.json?.response_type === "in_channel")) ?? { ok: true };
}

/** POST /api/chat/bot/respond/<token> { text, response_type }: a later answer to a command. */
export async function respond(token: string, b: { text?: unknown; response_type?: unknown }) {
  const p = pending.get(token);
  if (!p || p.until < Date.now()) throw new HttpError(404, "That response address has expired.");
  const text = String(b.text ?? "").trim().slice(0, 12000);
  if (!text) bad("Send { text }.");
  return (await answer(p, text, b.response_type === "in_channel")) ?? { ok: true };
}

// ── Workflows ──────────────────────────────────────────────────────────────

type Field = { key: string; label: string; type: "text" | "long" | "select"; options: string[]; required: boolean };
type Trigger = { type: "joined" | "keyword" | "reaction" | "schedule" | "shortcut"; channelId: string; keyword?: string; emoji?: string; time?: string; days?: number[]; tz?: string; fields?: Field[] };
type Step =
  | { type: "message"; channelId: string; text: string }
  | { type: "dm"; to: string; text: string }
  | { type: "task"; projectId: string; title: string; assignee: string }
  | { type: "react"; emoji: string };
type Ctx = { user?: { id: string; name: string }; channel?: Channel; message?: Message; emoji?: string; form?: Record<string, string> };

const TRIGGERS = ["joined", "keyword", "reaction", "schedule", "shortcut"];

async function cleanWorkflow(me: Me, b: { name?: unknown; trigger?: unknown; steps?: unknown; enabled?: unknown }) {
  const name = str(b.name, 80);
  if (!name) bad("Give the workflow a name.");
  const t = (b.trigger ?? {}) as Record<string, unknown>;
  const type = String(t.type ?? "");
  if (!TRIGGERS.includes(type)) bad("Pick what starts the workflow.");
  const mine = async (id: string) => {
    const { ch, member } = await loadChannel(me, id).catch(() => bad("Pick a channel you're in."));
    if (!member || ch.kind === "dm") bad(`Join #${ch.name} first: workflows can only use channels you're in.`);
    return ch;
  };
  const trigger: Trigger = { type: type as Trigger["type"], channelId: "" };
  if (type !== "schedule" || t.channelId) trigger.channelId = (await mine(String(t.channelId ?? ""))).id;
  if (type === "keyword") {
    trigger.keyword = str(t.keyword, 60);
    if (!trigger.keyword) bad("Type the keyword or phrase to listen for.");
  }
  if (type === "reaction") {
    trigger.emoji = str(t.emoji, 32);
    if (!trigger.emoji) bad("Pick the emoji to listen for.");
  }
  if (type === "schedule") {
    trigger.time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.time)) ? String(t.time) : bad("Pick a time like 09:00.");
    trigger.days = [...new Set((Array.isArray(t.days) ? t.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (!trigger.days.length) bad("Pick at least one day.");
    trigger.tz = str(t.tz, 60) || me.tz || "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trigger.tz });
    } catch {
      bad("That time zone isn't known.");
    }
  }
  if (type === "shortcut") {
    const fs = Array.isArray(t.fields) ? t.fields.slice(0, 10) : [];
    trigger.fields = fs.map((f: Record<string, unknown>, i: number) => {
      const label = str(f?.label, 80) || bad("Every form field needs a label.");
      const ft = ["text", "long", "select"].includes(String(f?.type)) ? (String(f.type) as Field["type"]) : "text";
      const options = ft === "select" ? (Array.isArray(f?.options) ? f.options : String(f?.options ?? "").split(",")).map((o) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 20) : [];
      if (ft === "select" && !options.length) bad(`Give "${label}" some options.`);
      return { key: String(f?.key ?? "").replace(/[^a-z0-9_]/gi, "").slice(0, 30) || `field${i + 1}`, label, type: ft, options, required: !!f?.required };
    });
  }
  const raw = Array.isArray(b.steps) ? b.steps.slice(0, 10) : [];
  if (!raw.length) bad("Add at least one step.");
  const steps: Step[] = [];
  for (const s of raw as Record<string, unknown>[]) {
    switch (s?.type) {
      case "message": {
        const text = str(s.text, 4000) || bad("A message step needs text.");
        const channelId = s.channelId === "trigger" ? (trigger.channelId ? "trigger" : bad("A scheduled workflow needs a channel for its message.")) : (await mine(String(s.channelId ?? ""))).id;
        steps.push({ type: "message", channelId, text });
        break;
      }
      case "dm": {
        const text = str(s.text, 4000) || bad("A direct message step needs text.");
        const to = String(s.to ?? "");
        if (to !== "trigger_user" && !(await db.member.findFirst({ where: { ws: me.ws, userId: to } }))) bad("Pick who gets the direct message.");
        if (to === "trigger_user" && type === "schedule") bad("A scheduled workflow has no person to message; pick someone.");
        steps.push({ type: "dm", to, text });
        break;
      }
      case "task": {
        if (!me.perms["tasks.create"]) bad("Your role can't create tasks.");
        const projectId = String(s.projectId ?? "");
        const p = await db.project.findUnique({ where: { id: projectId } });
        if (!p || p.ws !== me.ws) bad("Pick a project for the task.");
        steps.push({ type: "task", projectId, title: str(s.title, 200) || bad("A task step needs a title."), assignee: s.assignee === "trigger_user" ? "trigger_user" : "" });
        break;
      }
      case "react":
        if (!["keyword", "reaction"].includes(type)) bad("Reacting only works for keyword and reaction workflows.");
        steps.push({ type: "react", emoji: str(s.emoji, 32) || bad("Pick an emoji.") });
        break;
      default:
        bad("Unknown step.");
    }
  }
  return { name, trigger, steps, enabled: b.enabled === undefined ? true : !!b.enabled };
}

function wfDto(w: ChatWorkflow) {
  return { id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger as Trigger, steps: w.steps as Step[], createdBy: w.createdBy, createdAt: w.createdAt, lastRunAt: w.lastRunAt, runs: w.runs, lastError: w.lastError };
}

export async function listWorkflows(me: Me, q: { channelId?: string } = {}) {
  const rows = await db.chatWorkflow.findMany({ where: { ws: me.ws }, orderBy: { createdAt: "asc" } });
  if (q.channelId) {
    // Shortcuts people can run in this channel.
    return rows.filter((w) => w.enabled && (w.trigger as Trigger).type === "shortcut" && (w.trigger as Trigger).channelId === q.channelId).map((w) => ({ id: w.id, name: w.name, fields: (w.trigger as Trigger).fields ?? [] }));
  }
  return rows.filter((w) => w.createdBy === me.userId || isAdmin(me)).map(wfDto);
}

const canBuild = (me: Me) => {
  if (isGuest(me)) throw new HttpError(403, "Guests can't build workflows.");
};

export async function createWorkflow(me: Me, b: Record<string, unknown>) {
  canBuild(me);
  if ((await db.chatWorkflow.count({ where: { ws: me.ws } })) >= 200) bad("A workspace can have up to 200 workflows.");
  const w = await cleanWorkflow(me, b);
  const row = await db.chatWorkflow.create({ data: { ws: me.ws, name: w.name, enabled: w.enabled, trigger: w.trigger, steps: w.steps, createdBy: me.userId, lastDay: w.trigger.type === "schedule" ? scheduleDay(w.trigger, new Date(), true) : null } });
  return wfDto(row);
}

async function ownWorkflow(me: Me, id: string) {
  const w = await db.chatWorkflow.findUnique({ where: { id } });
  if (!w || w.ws !== me.ws) throw new HttpError(404, "Workflow not found");
  if (w.createdBy !== me.userId && !isAdmin(me)) throw new HttpError(403, "Only its builder or an admin can change this workflow.");
  return w;
}

export async function updateWorkflow(me: Me, id: string, b: Record<string, unknown>) {
  canBuild(me);
  const old = await ownWorkflow(me, id);
  if (Object.keys(b).length === 1 && b.enabled !== undefined) return wfDto(await db.chatWorkflow.update({ where: { id }, data: { enabled: !!b.enabled } }));
  const w = await cleanWorkflow(me, { name: b.name ?? old.name, trigger: b.trigger ?? old.trigger, steps: b.steps ?? old.steps, enabled: b.enabled ?? old.enabled });
  return wfDto(await db.chatWorkflow.update({ where: { id }, data: { name: w.name, enabled: w.enabled, trigger: w.trigger, steps: w.steps, lastError: null } }));
}

export async function deleteWorkflow(me: Me, id: string) {
  await ownWorkflow(me, id);
  await db.chatWorkflow.delete({ where: { id } });
  return { ok: true };
}

/** The workflow's builder, as a Me with what workflows may do (checked again at run time). */
async function builder(w: ChatWorkflow): Promise<Me | null> {
  const u = await db.user.findUnique({ where: { id: w.createdBy } });
  if (!u || !(await db.member.findFirst({ where: { ws: w.ws, userId: u.id } }))) return null;
  return { sid: "workflow", userId: u.id, ws: w.ws, name: u.name ?? u.email, email: u.email, tz: u.tz, owner: false, perms: { "teamchat.open": true, "tasks.open": true, "tasks.create": true, "tasks.assign": true }, stale: false, guest: false };
}

const recent = new Map<string, number[]>();

function fill(text: string, w: ChatWorkflow, ctx: Ctx, tz: string) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k: string) => {
    if (k === "user") return ctx.user ? `@${ctx.user.name}` : "";
    if (k === "user.name") return ctx.user?.name ?? "";
    if (k === "channel") return ctx.channel ? `#${ctx.channel.name}` : "";
    if (k === "message") return ctx.message?.body ?? "";
    if (k === "emoji") return ctx.emoji ?? "";
    if (k === "workflow") return w.name;
    if (k === "date") return new Date().toLocaleDateString("en-IN", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
    if (k.startsWith("form.")) return ctx.form?.[k.slice(5)] ?? "";
    return all;
  });
}

/** Runs a workflow's steps. Errors are recorded on the workflow (and returned), not thrown. */
export async function runWorkflow(w: ChatWorkflow, ctx: Ctx) {
  if (!w.enabled) return { ok: false, error: "This workflow is turned off." };
  // At most 20 runs a minute, so a busy channel can't flood.
  const now = Date.now();
  const times = (recent.get(w.id) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= 20) return { ok: false, error: "Ran too often in the last minute." };
  recent.set(w.id, [...times, now]);
  const owner = await builder(w);
  const t = w.trigger as Trigger;
  let error: string | null = null;
  if (!owner) error = "Its builder has left the workspace.";
  const app: Me = { sid: "workflow", userId: `wf_${w.id}`, ws: w.ws, name: w.name, email: "", tz: owner?.tz ?? "UTC", owner: false, perms: {}, stale: false, guest: false };
  const tz = t.tz || owner?.tz || "UTC";
  for (const s of owner ? (w.steps as Step[]) : []) {
    try {
      if (s.type === "message") {
        const channelId = s.channelId === "trigger" ? ctx.channel?.id ?? t.channelId : s.channelId;
        // The builder must still be in the channel.
        const { member } = await loadChannel(owner!, channelId);
        if (!member) throw new Error("its builder is no longer in that channel");
        await postMessage(app, channelId, { body: fill(s.text, w, ctx, tz) }, { asApp: true });
      } else if (s.type === "dm") {
        const to = s.to === "trigger_user" ? ctx.user?.id : s.to;
        if (!to || isAppId(to)) continue;
        await postMessage(app, (await workflowDm(w, to)).id, { body: fill(s.text, w, ctx, tz) }, { asApp: true });
      } else if (s.type === "task") {
        const assignee = s.assignee === "trigger_user" && ctx.user && !ctx.user.id.startsWith("guest_") ? ctx.user.id : undefined;
        await createTask(owner!, { projectId: s.projectId, title: fill(s.title, w, ctx, tz).slice(0, 200) || w.name, description: ctx.message?.body ? `From Chat: ${ctx.message.body.slice(0, 2000)}` : "", ...(assignee ? { assigneeId: assignee } : {}) });
      } else if (s.type === "react" && ctx.message) {
        const had = await db.reaction.findUnique({ where: { messageId_userId_emoji: { messageId: ctx.message.id, userId: app.userId, emoji: s.emoji } } });
        if (!had) await toggleReactionAsApp(app, ctx.message.id, s.emoji);
      }
    } catch (e) {
      error = `${s.type} step: ${(e as Error).message}`;
      break;
    }
  }
  await db.chatWorkflow.update({ where: { id: w.id }, data: { runs: { increment: 1 }, lastRunAt: new Date(), lastError: error } });
  return error ? { ok: false, error } : { ok: true };
}

async function toggleReactionAsApp(app: Me, messageId: string, emoji: string) {
  await db.reaction.create({ data: { messageId, userId: app.userId, emoji } }).catch(() => null);
  await republish(app.ws, messageId, "reaction");
}

/** A one-to-one conversation between a workflow and a person. */
async function workflowDm(w: ChatWorkflow, userId: string) {
  const ids = [`wf_${w.id}`, userId].sort();
  const dmKey = ids.join(":");
  const had = await db.channel.findUnique({ where: { ws_dmKey: { ws: w.ws, dmKey } } });
  if (had) return had;
  const ch = await db.channel.create({ data: { ws: w.ws, kind: "dm", name: "dm", dmKey, createdBy: userId, members: { create: ids.map((u) => ({ userId: u })) } } });
  publish(`ws:${w.ws}`, { type: "channel", channelId: ch.id, kind: ch.kind });
  return ch;
}

const live = (ws: string) => db.chatWorkflow.findMany({ where: { ws, enabled: true } });
const said = (text: string, kw: string) => new RegExp(`(^|[^\\w])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`, "i").test(text);

/** After a person's message: events to bots in the conversation, and keyword workflows. */
export async function afterMessage(me: Me, ch: Channel, msg: Message) {
  const members = await db.channelMember.findMany({ where: { channelId: ch.id, userId: { startsWith: "bot_" } } });
  if (members.length) {
    const bots = await db.chatBot.findMany({ where: { userId: { in: members.map((m) => m.userId) }, disabledAt: null, eventsUrl: { not: "" } } });
    await Promise.all(bots.map((b) => botEvent(b, me, ch, msg, msg.mentions.includes(b.userId)).catch(() => {})));
  }
  if (ch.kind === "dm" || !msg.body) return;
  for (const w of await live(ch.ws)) {
    const t = w.trigger as Trigger;
    if (t.type === "keyword" && t.channelId === ch.id && t.keyword && said(msg.body, t.keyword))
      await runWorkflow(w, { user: { id: me.userId, name: me.name }, channel: ch, message: msg });
  }
}

export async function onReaction(me: Me, ch: Channel, msg: Message, emoji: string) {
  for (const w of await live(ch.ws)) {
    const t = w.trigger as Trigger;
    if (t.type === "reaction" && t.channelId === ch.id && t.emoji === emoji) await runWorkflow(w, { user: { id: me.userId, name: me.name }, channel: ch, message: msg, emoji });
  }
}

export async function onJoined(me: Me, ch: Channel, userIds: string[]) {
  const ws = await live(ch.ws);
  const flows = ws.filter((w) => (w.trigger as Trigger).type === "joined" && (w.trigger as Trigger).channelId === ch.id);
  if (!flows.length) return;
  const users = await db.user.findMany({ where: { id: { in: userIds.filter((u) => !isAppId(u)) } } });
  for (const u of users) for (const w of flows) await runWorkflow(w, { user: { id: u.id, name: u.name ?? u.email }, channel: ch });
  void me;
}

/** A shortcut from the channel's ⚡ menu, with its form filled in. */
export async function runShortcut(me: Me, id: string, channelId: string, form: Record<string, unknown>) {
  const w = await db.chatWorkflow.findUnique({ where: { id } });
  const t = w?.trigger as Trigger | undefined;
  if (!w || w.ws !== me.ws || !w.enabled || t?.type !== "shortcut") throw new HttpError(404, "Workflow not found");
  const { ch, member } = await loadChannel(me, channelId);
  if (!member || t.channelId !== ch.id) bad("Run this workflow from its channel.");
  const values: Record<string, string> = {};
  for (const f of t.fields ?? []) {
    const v = String(form?.[f.key] ?? "").trim().slice(0, f.type === "long" ? 4000 : 300);
    if (f.required && !v) bad(`Fill in "${f.label}".`);
    if (f.type === "select" && v && !f.options.includes(v)) bad(`Pick one of the options for "${f.label}".`);
    values[f.key] = v;
  }
  const r = await runWorkflow(w, { user: { id: me.userId, name: me.name }, channel: ch, form: values });
  if (!r.ok) bad(`The workflow stopped: ${r.error}`);
  return r;
}

/** YYYY-MM-DD in the trigger's zone; with `passed`, the day only if its time has already gone by today. */
function scheduleDay(t: Trigger, now: Date, passed = false) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: t.tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (!passed) return day;
  return `${parts.hour}:${parts.minute}` >= (t.time ?? "00:00") ? day : null;
}

/** Every 30 s from chatTick: scheduled workflows whose time has come today (once a day, within 15 minutes). */
export async function workflowTick(now = new Date()) {
  let ran = 0;
  for (const w of await db.chatWorkflow.findMany({ where: { enabled: true } })) {
    const t = w.trigger as Trigger;
    if (t.type !== "schedule" || !t.time) continue;
    const tz = t.tz || "UTC";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    const [h, m] = t.time.split(":").map(Number);
    const mins = Number(parts.hour) * 60 + Number(parts.minute) - (h * 60 + m);
    const day = scheduleDay(t, now);
    if (!t.days?.includes(dow) || mins < 0 || mins > 15 || w.lastDay === day) continue;
    // Claim the day first, so two ticks can't both run it.
    const claimed = await db.chatWorkflow.updateMany({ where: { id: w.id, OR: [{ lastDay: null }, { lastDay: { not: day } }] }, data: { lastDay: day } });
    if (!claimed.count) continue;
    const ch = t.channelId ? await db.channel.findUnique({ where: { id: t.channelId } }) : null;
    await runWorkflow(w, { channel: ch ?? undefined });
    ran++;
  }
  return ran;
}
