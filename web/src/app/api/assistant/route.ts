import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { runAssistant, type AssistantEvent } from "@/lib/assistant";
import type { OpenTab } from "@/lib/suite-ai";
import { InsufficientCredits, SpendLimitReached } from "@/lib/credits";
import { requirePerm } from "@/lib/iotx/permissions";

export const maxDuration = 300;

/** The user's assistant chats, or one chat's messages with ?chat=. */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  // What the AI remembers about this person, newest first.
  if (q.get("memory")) {
    const memory = await db.assistantMemory.findMany({ where: { userId: user.id, workspaceId: ws.id }, orderBy: { createdAt: "desc" }, take: 200 });
    return Response.json({ memory: memory.map((m) => ({ id: m.id, fact: m.fact, source: m.source, at: m.createdAt })) });
  }
  const chatId = q.get("chat");
  if (chatId) {
    const chat = await db.workspaceChat.findFirst({ where: { id: chatId, userId: user.id, workspaceId: ws.id } });
    if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
    const messages = await db.workspaceChatMessage.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } });
    return Response.json({ chat, messages });
  }
  const chats = await db.workspaceChat.findMany({ where: { userId: user.id, workspaceId: ws.id }, orderBy: { updatedAt: "desc" }, take: 50 });
  return Response.json({ chats });
}

/** Send a message; answers when the assistant is done. */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as {
    chatId?: string;
    content?: string;
    projectIds?: string[];
    files?: { projectId: string; uploadId: string }[];
    chatIds?: string[];
    action?: string;
    stream?: boolean;
    tabs?: unknown;
    refs?: unknown;
  };

  if (body.action === "delete" && body.chatId) {
    await db.workspaceChat.deleteMany({ where: { id: body.chatId, userId: user.id } });
    return Response.json({ ok: true });
  }
  const b = body as { memoryId?: string; fact?: string };
  if (body.action === "forget" && b.memoryId) {
    await db.assistantMemory.deleteMany({ where: { id: b.memoryId, userId: user.id, workspaceId: ws.id } });
    return Response.json({ ok: true });
  }
  if (body.action === "remember" && b.fact?.trim()) {
    const m = await db.assistantMemory.create({ data: { userId: user.id, workspaceId: ws.id, fact: b.fact.trim().slice(0, 500), source: "user" } });
    return Response.json({ memory: { id: m.id, fact: m.fact, source: m.source, at: m.createdAt } });
  }

  await requirePerm(user.id, ws.id, "home.ask");
  const text = body.content?.trim().slice(0, 8000);
  if (!text) return Response.json({ error: "Message is empty" }, { status: 400 });
  let chat = body.chatId
    ? await db.workspaceChat.findFirst({ where: { id: body.chatId, userId: user.id, workspaceId: ws.id } })
    : null;
  if (body.chatId && !chat) return Response.json({ error: "Not found" }, { status: 404 });
  chat ??= await db.workspaceChat.create({ data: { workspaceId: ws.id, userId: user.id, title: text.slice(0, 60) } });

  const tabs = cleanTabs(body.tabs);
  const refs = cleanRefs(body.refs);
  const run = (onEvent?: (e: AssistantEvent) => void) =>
    runAssistant({ chatId: chat.id, userId: user.id, workspaceId: ws.id, text, projectIds: (body.projectIds ?? []).slice(0, 10), files: body.files, chatIds: body.chatIds, tabs, refs, onEvent });
  const save = async (result: Awaited<ReturnType<typeof run>>) => {
    await db.workspaceChatMessage.create({ data: { chatId: chat.id, role: "user", content: text } });
    const reply = await db.workspaceChatMessage.create({
      data: { chatId: chat.id, role: "assistant", content: result.reply, steps: result.steps },
    });
    await db.workspaceChat.update({ where: { id: chat.id }, data: { updatedAt: new Date() } });
    return reply;
  };
  const failure = (e: unknown) =>
    e instanceof InsufficientCredits || e instanceof SpendLimitReached ? "You're out of credits or at a spending limit." : null;

  // Streamed: one JSON event per line while the reply is made, then "done" with the saved reply.
  if (body.stream) {
    const chatId = chat.id;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        const send = (e: object) => c.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        send({ type: "chat", chatId });
        try {
          const result = await run(send);
          const reply = await save(result);
          send({ type: "done", chatId, reply, free: result.free });
        } catch (e) {
          console.error("[assistant]", e);
          send({ type: "error", error: failure(e) ?? "Something went wrong. Try again." });
        }
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  try {
    const result = await run();
    const reply = await save(result);
    return Response.json({ chatId: chat.id, reply, free: result.free });
  } catch (e) {
    const msg = failure(e);
    if (msg) return Response.json({ error: msg }, { status: 402 });
    throw e;
  }
}

/** The @-referenced things the browser read for this message (as the person): bounded, text only. */
function cleanRefs(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return raw
    .slice(0, 6)
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return { title: str(o.title, 200), url: str(o.url, 500), text: str(o.text, 30_000) };
    })
    .filter((r) => r.text);
}

/** The open tabs the floating assistant sent: bounded, text only. */
function cleanTabs(raw: unknown): OpenTab[] | null {
  if (!Array.isArray(raw)) return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return raw.slice(0, 20).map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return {
      id: str(o.id, 60),
      title: str(o.title, 200) || "Tab",
      url: str(o.url, 500),
      active: o.active === true,
      text: str(o.text, 40_000) || undefined,
      fields: Array.isArray(o.fields) ? o.fields.slice(0, 20).map((f) => str(f, 120)) : undefined,
    };
  });
}

export const GET = route(GET_);
export const POST = route(POST_);
