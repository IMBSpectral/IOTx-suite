import Anthropic from "@anthropic-ai/sdk";
import { attachmentBlocks, readUpload } from "./uploads";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "./db";
import { listFiles } from "./repo";
import { visibleTo } from "./projects";
import { projectAccess } from "./workspace";
import { createProject } from "./create-project";
import { enqueueTurn } from "./turns";
import { getMonitoring } from "./monitoring";
import { assertCredits, charge, creditsForUsage, spendFreeChat } from "./credits";
import { effectiveForRequest } from "./iotx/permissions";
import { getBrand, type Brand } from "./brand";
import * as kb from "./kb";
import { audit } from "./workspace-security";
import { SUITE_PROMPT, memoryContext, suiteTools, type OpenTab, type SuiteAction } from "./suite-ai";
import { meteredFetch } from "./ai-meter";

/**
 * The workspace assistant: a chat that isn't tied to one project. It can look
 * across the workspace's projects, say what Forge is changing right now,
 * create projects and send work into them. Each send is an ordinary turn in
 * that project's chat, so the project's own agent does the building.
 */

const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}), fetch: meteredFetch("AI Chat") });
const MODEL = "claude-opus-5-5";

const system = (b: Brand) => `You are ${b.shortName}, the AI assistant in ${b.name}: a business suite with an AI app Builder (each project is a React app built by an agent in that project's own chat), plus Sheets, Docs, Slides, Tally accounting, Tasks and more.

You are a capable general assistant for the person's work: discuss ideas, answer business, accounting and technical questions, draft text, and think problems through with them. Across the workspace you can also answer questions about projects, review them, suggest what to build next, start new projects, and send work into existing ones (when their role allows building). You don't edit code yourself — to change an app, use send_to_project with a clear, self-contained instruction for the project's agent. To start something new, use create_project with a concrete first prompt.

For anything about this company's own facts or ways of working (prices, processes, policies, customers, terms), search the company knowledge base first and cite the articles you used. Look things up with the tools rather than guessing. Be brief and concrete. When you've sent work somewhere, say so and name the project.`;

export type AssistantStep = { kind: "sent" | "created" | "looked"; label: string; projectId?: string };

/** What a reply streams while it's being made, for the live view (AI Chat and the floating assistant). */
export type AssistantEvent =
  | { type: "thought"; delta: string }
  | { type: "activity"; tool: string }
  | { type: "text"; delta: string }
  | { type: "step"; step: AssistantStep }
  | { type: "action"; action: SuiteAction };

/** A step list that also reports each step as it's added. */
function liveSteps(on?: (e: AssistantEvent) => void): AssistantStep[] {
  const steps: AssistantStep[] = [];
  const push = steps.push.bind(steps);
  steps.push = (...s: AssistantStep[]) => {
    for (const step of s) on?.({ type: "step", step });
    return push(...s);
  };
  return steps;
}

/**
 * Knowledge first: the company knowledge this message gets before the model
 * acts, looked up by the platform as the person (the projects they added help
 * find the right articles). Empty when their role can't read the knowledge base.
 */
export async function assistantKnowledge(userId: string, workspaceId: string, text: string, projectNames: string[] = []) {
  return kb.consultAs(userId, workspaceId, text, { context: projectNames.join(" "), tool: true });
}

function tools(opts: { userId: string; workspaceId: string; steps: AssistantStep[]; perms: Set<string> }) {
  const { userId, steps } = opts;

  async function accessible(projectId: string, need: "view" | "edit") {
    const p = await db.project.findUnique({ where: { id: projectId } });
    if (!p || p.deletedAt || p.workspaceId !== opts.workspaceId) throw new Error("No such project in this workspace.");
    const access = await projectAccess(userId, p);
    if (!access || (need === "edit" && access === "view")) throw new Error(`You don't have ${need} access to ${p.name}.`);
    return p;
  }

  const knowledge = betaZodTool({
    name: "search_company_knowledge",
    description:
      "Search the company's own knowledge base (SOPs, policies, processes, products and prices, customers, vendors, glossary). " +
      "Use it for any question about how this company does things or its own facts, and cite the article titles you used.",
    inputSchema: z.object({ query: z.string().min(2).max(300) }),
    run: async ({ query }) => {
      const v = await kb.viewer(userId, opts.workspaceId);
      if (!kb.canRead(v)) return "This person's role can't read the knowledge base.";
      const hits = await kb.search(v, query, { limit: 6, logGap: true, platform: true });
      steps.push({ kind: "looked", label: `Company knowledge: ${query.slice(0, 60)}` });
      return hits.length ? kb.formatHits(hits, 7000) : "Nothing in the knowledge base matched. Answer from general knowledge; only the company's own specifics (its prices, policies, people) shouldn't be guessed.";
    },
  });

  const suggestKnowledge = betaZodTool({
    name: "suggest_knowledge_update",
    description: "Propose a lasting company fact the user told you (a new price, a changed process) for the knowledge base. A reviewer approves it first.",
    inputSchema: z.object({ title: z.string().min(3).max(200), body: z.string().min(5).max(5000), docId: z.string().optional(), reason: z.string().max(400).optional() }),
    run: async ({ title, body, docId, reason }) => {
      const v = await kb.viewer(userId, opts.workspaceId);
      if (!v.e?.keys.includes("read.suggest")) return "This person's role can't suggest knowledge updates.";
      try {
        await kb.suggest(v, { title, body, docId: docId ?? null, mode: "append", reason, source: "assistant" });
      } catch (e) {
        return e instanceof kb.KbError ? e.message : "The suggestion couldn't be saved.";
      }
      steps.push({ kind: "looked", label: `Suggested a knowledge update: ${title.slice(0, 60)}` });
      return "Suggested; a reviewer will approve it.";
    },
  });

  const list = betaZodTool({
    name: "list_projects",
    description: "List the workspace's projects the user can see, newest first.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await db.project.findMany({
        where: { workspaceId: opts.workspaceId, deletedAt: null, ...(await visibleTo(userId, opts.workspaceId)) },
        orderBy: { updatedAt: "desc" },
        take: 40,
        select: { id: true, name: true, updatedAt: true, publishedSha: true, subdomain: true },
      });
      return JSON.stringify(rows.map((p) => ({ id: p.id, name: p.name, updated: p.updatedAt.toISOString().slice(0, 10), published: !!p.publishedSha })));
    },
  });

  const details = betaZodTool({
    name: "project_details",
    description:
      "Everything useful about one project: its files, recent chat, what the agent is working on right now, open drafts, " +
      "publish state and open monitoring findings.",
    inputSchema: z.object({ projectId: z.string() }),
    run: async ({ projectId }) => {
      const p = await accessible(projectId, "view");
      steps.push({ kind: "looked", label: `Looked at ${p.name}`, projectId });
      const [files, messages, running, queued, drafts, monitoring] = await Promise.all([
        listFiles(projectId),
        db.message.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 8, select: { role: true, content: true } }),
        db.build.findFirst({ where: { projectId, status: "RUNNING" }, select: { messageId: true } }),
        db.build.count({ where: { projectId, status: "QUEUED" } }),
        db.draft.findMany({ where: { projectId, status: { in: ["BUILDING", "READY"] } }, select: { name: true, status: true } }),
        getMonitoring(projectId),
      ]);
      let workingOn: string | null = null;
      if (running?.messageId) {
        const reply = await db.message.findUnique({ where: { id: running.messageId }, select: { createdAt: true } });
        const ask = reply
          ? await db.message.findFirst({ where: { projectId, role: "USER", createdAt: { lte: reply.createdAt } }, orderBy: { createdAt: "desc" }, select: { content: true } })
          : null;
        workingOn = ask?.content.slice(0, 300) ?? "a change";
      }
      const latest = monitoring.runs[0];
      return JSON.stringify({
        name: p.name,
        published: !!p.publishedSha,
        files: files.filter((f) => !f.startsWith("src/components/ui/")).slice(0, 80),
        workingOnNow: workingOn,
        queuedMessages: queued,
        openDrafts: drafts,
        recentChat: messages.reverse().map((m) => ({ role: m.role.toLowerCase(), text: m.content.slice(0, 400) })),
        monitoring: latest ? { at: latest.at, openFindings: latest.findings.filter((f) => !monitoring.ignored.includes(f.key)).map((f) => `${f.severity}: ${f.title}`) } : null,
      }).slice(0, 20_000);
    },
  });

  const create = betaZodTool({
    name: "create_project",
    description: "Create a new project and start building it with a first prompt for its agent.",
    inputSchema: z.object({ name: z.string().max(60), prompt: z.string().describe("The first instruction for the project's agent") }),
    run: async ({ name, prompt }) => {
      const p = await createProject({ workspaceId: opts.workspaceId, userId, name });
      await enqueueTurn({ projectId: p.id, userId, content: prompt });
      steps.push({ kind: "created", label: `Created ${p.name}`, projectId: p.id });
      void audit(opts.workspaceId, userId, "ai.action", `Created the project "${p.name}": ${prompt.slice(0, 200)}`, p.id);
      return `Created "${p.name}" (${p.id}) and sent the first prompt; its agent is building now.`;
    },
  });

  const send = betaZodTool({
    name: "send_to_project",
    description:
      "Send work into a project: the message is queued in that project's chat and its agent carries it out. " +
      "Use mode ask for questions that shouldn't change the app.",
    inputSchema: z.object({ projectId: z.string(), message: z.string(), mode: z.enum(["build", "ask", "plan"]).optional() }),
    run: async ({ projectId, message, mode }) => {
      // IOTx Suite 2-in-1: changing an app needs the Builder switch and that mode.
      const need = mode === "ask" ? "home.ask" : mode === "plan" ? "builder.plan" : "builder.build";
      if (!opts.perms.has(need)) return `Not sent: the user's role doesn't include ${need === "builder.plan" ? "Plan mode" : "Build mode"}. Discuss it instead, or suggest they ask an admin to turn on Builder.`;
      const p = await accessible(projectId, "edit");
      await enqueueTurn({ projectId, userId, content: message, mode: mode ?? "build", messageMode: "assistant" });
      steps.push({ kind: "sent", label: `Sent work to ${p.name}`, projectId });
      void audit(opts.workspaceId, userId, "ai.action", `Sent work to "${p.name}" (${mode ?? "build"}): ${message.slice(0, 200)}`, projectId);
      return `Queued in ${p.name}'s chat.`;
    },
  });

  // Without the Builder switch the assistant only chats: no project creation, and send_to_project is Ask only.
  const builder = opts.perms.has("builder.open");
  return [list, details, ...(builder && opts.perms.has("builder.project.create") && opts.perms.has("builder.build") ? [create] : []), send, ...(opts.perms.has("read.view") ? [knowledge] : []), ...(opts.perms.has("read.suggest") ? [suggestKnowledge] : [])];
}

export async function runAssistant(opts: {
  chatId: string;
  userId: string;
  workspaceId: string;
  text: string;
  projectIds: string[];
  /** Chat files added as context ({ projectId, uploadId }). */
  files?: { projectId: string; uploadId: string }[];
  /** Earlier assistant chats added as context. */
  chatIds?: string[];
  /** The suite tabs open in the person's browser (the floating assistant sends them). */
  tabs?: OpenTab[] | null;
  /** What the message's @ references say (a task, a chat channel, a meeting…), read in the browser as the person. */
  refs?: { title: string; url: string; text: string }[];
  /** Called as the reply is made: reasoning, tools, text, steps and browser actions. */
  onEvent?: (e: AssistantEvent) => void;
}) {
  const on = opts.onEvent;
  await assertCredits(opts.workspaceId, { userId: opts.userId });
  const perms = new Set((await effectiveForRequest(opts.userId, opts.workspaceId))?.keys ?? []);
  const history = await db.workspaceChatMessage.findMany({ where: { chatId: opts.chatId }, orderBy: { createdAt: "asc" }, take: 40 });
  const added = opts.projectIds.length
    ? await db.project.findMany({ where: { id: { in: opts.projectIds }, workspaceId: opts.workspaceId }, select: { id: true, name: true } })
    : [];
  const context = added.length ? `\n\n(The user added these projects to the conversation: ${added.map((p) => `${p.name} [${p.id}]`).join(", ")})` : "";
  // Earlier chats the user pulled in: their transcripts, newest last.
  let previous = "";
  if (opts.chatIds?.length) {
    const chats = await db.workspaceChat.findMany({ where: { id: { in: opts.chatIds.slice(0, 5) }, userId: opts.userId, workspaceId: opts.workspaceId } });
    for (const c of chats) {
      const msgs = await db.workspaceChatMessage.findMany({ where: { chatId: c.id }, orderBy: { createdAt: "asc" }, take: 40 });
      previous += `\n\nEarlier chat "${c.title}":\n` + msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n").slice(0, 8000);
    }
  }
  // Chat files the user pulled in, read like message attachments.
  const fileBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const fileNames: string[] = [];
  for (const f of (opts.files ?? []).slice(0, 5)) {
    const p = await db.project.findFirst({ where: { id: f.projectId, workspaceId: opts.workspaceId, deletedAt: null }, select: { id: true } });
    const u = p ? await readUpload(p.id, f.uploadId) : null;
    if (!u) continue;
    const { blocks } = await attachmentBlocks(p!.id, [u.meta]);
    fileBlocks.push(...(blocks as Anthropic.Beta.BetaContentBlockParam[]));
    fileNames.push(u.meta.name);
  }
  const extra = (previous ? `\n\n(Context from earlier chats:${previous})` : "") + (fileNames.length ? `\n\n(Files the user added: ${fileNames.join(", ")})` : "");
  const steps = liveSteps(on);
  on?.({ type: "activity", tool: "search_company_knowledge" });
  const company = await assistantKnowledge(opts.userId, opts.workspaceId, opts.text, added.map((p) => p.name));
  if (company.context) steps.push({ kind: "looked", label: company.hits.length ? `Checked company knowledge (${company.hits.length})` : "Checked company knowledge: nothing matched" });
  const base = perms.has("builder.open")
    ? system(getBrand())
    : `${system(getBrand())}\n\nThis user's role chats only: Builder is off for them. Discuss, explain and advise; never create projects or change apps (send_to_project works in ask mode only). If they want something built, tell them an admin can turn on Builder for their role.`;
  const memory = await memoryContext(opts.userId, opts.workspaceId);
  const tabsNote = opts.tabs?.length
    ? `\n\nThe person has these suite tabs open (n, id, title, address):\n${opts.tabs.map((t, i) => `${i + 1}. [${t.id}] ${t.title} — ${t.url}${t.active ? " (active: the one they're looking at)" : ""}`).join("\n")}`
    : "";
  const suite = suiteTools({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    perms,
    tabs: opts.tabs ?? null,
    live: { step: (label) => steps.push({ kind: "looked", label }), action: (action) => on?.({ type: "action", action }) },
  });
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive", display: "summarized" },
    // Each tool round resends the same prompt: cache it so later rounds read it at a tenth of the price.
    cache_control: { type: "ephemeral" },
    stream: true,
    system: `${base}\n\n${SUITE_PROMPT}${memory}${tabsNote}${company.context ? `\n\n${company.context}` : ""}`,
    tools: [...tools({ userId: opts.userId, workspaceId: opts.workspaceId, steps, perms }), ...suite],
    messages: [
      ...history.map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.content })),
      {
        role: "user" as const,
        content: [
          ...fileBlocks,
          { type: "text" as const, text: opts.text + context + extra },
          // What the @ references in the message point to, read as the person (a task, a chat channel, a meeting…).
          ...(opts.refs?.length
            ? [{ type: "text" as const, text: `Referenced with @ in this message:\n\n${opts.refs.map((r) => `<ref title="${r.title.replace(/"/g, "'")}" link="${r.url}">\n${r.text}\n</ref>`).join("\n\n")}` }]
            : []),
        ],
      },
    ],
  });
  let input = 0;
  let output = 0;
  let last: Anthropic.Beta.BetaMessage | null = null;
  for await (const stream of runner) {
    for await (const ev of stream) {
      if (!on) continue;
      if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") on({ type: "thought", delta: ev.delta.thinking });
      else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") on({ type: "text", delta: ev.delta.text });
      else if (ev.type === "content_block_start" && (ev.content_block.type === "tool_use" || ev.content_block.type === "server_tool_use")) on({ type: "activity", tool: ev.content_block.name });
    }
    const message = await stream.finalMessage();
    input += message.usage.input_tokens;
    output += message.usage.output_tokens;
    last = message;
    // A long web search pauses the turn; hand it back to carry on.
    if (message.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: message.content });
  }
  const reply =
    last?.stop_reason === "refusal"
      ? "I can't help with that one."
      : (last?.content ?? [])
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim() || "Done.";

  // Chat with the assistant counts against the same free daily allowance as Ask mode.
  const free = await spendFreeChat(opts.workspaceId, opts.userId);
  if (!free) await charge(opts.workspaceId, creditsForUsage(input, output), "GENERATION", undefined, { category: "chat", userId: opts.userId });
  return { reply, steps, free };
}
