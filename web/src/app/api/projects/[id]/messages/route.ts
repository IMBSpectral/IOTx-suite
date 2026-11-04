import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { assertCredits, InsufficientCredits, SpendLimitReached } from "@/lib/credits";
import { ensureWorker } from "@/lib/worker";
import { resolveAttachments } from "@/lib/uploads";
import { route } from "@/lib/route";
import { countMessage, messageLimit } from "@/lib/rate-limit";
import { GOAL_TURNS } from "@/lib/turns";
import { assertCreditLimit, keyForMode, requirePerm } from "@/lib/iotx/permissions";

async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  const chat = new URL(req.url).searchParams.get("chat");
  const messages = await db.message.findMany({
    where: { projectId: id, chatId: chat || null },
    orderBy: { createdAt: "asc" },
    include: { build: { select: { id: true, status: true, error: true } } },
  });
  return Response.json({ messages });
}

/**
 * Enqueue a build and return immediately.
 *
 * The work is done by the queue worker, not by this request, so a build
 * survives a reload, a navigation, or a closed laptop. The client follows
 * progress on the build's event stream.
 */
async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");

  const { content, mode, attachmentIds, freeFix, chatId } = (await req.json()) as {
    /** Which chat this goes to; omitted for the main chat. */
    chatId?: string | null;
    content?: string;
    mode?: string;
    attachmentIds?: string[];
    /** "Try to fix" on a preview error: free, within limits. */
    freeFix?: boolean;
  };

  if (!content?.trim()) {
    return Response.json({ error: "Message is empty" }, { status: 400 });
  }
  if (chatId && !(await db.projectChat.findFirst({ where: { id: chatId, projectId: id } }))) {
    return Response.json({ error: "That chat doesn't exist in this project." }, { status: 404 });
  }

  // Plan rate limit (free fixes for a preview error don't count).
  if (!freeFix) {
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: project.workspaceId }, select: { plan: true } });
    const limited = messageLimit(user.id, project.workspaceId, ws.plan);
    if (limited) return Response.json(limited, { status: 429, headers: { "retry-after": String(limited.retryAfter) } });
  }

  const chosen = mode === "ask" || mode === "design" || mode === "plan" || mode === "goal" ? mode : "build";
  // A goal runs as Build turns; the message keeps "goal" so the chat can say so.
  const buildMode = chosen === "goal" ? "build" : chosen;
  // IOTx Suite 2-in-1: Ask is chat for anyone with "Ask IOTx"; Plan and Build need the Builder switch.
  await requirePerm(user.id, project.workspaceId, keyForMode(chosen));
  if (!freeFix) await assertCreditLimit(user.id, project.workspaceId);
  // Only files uploaded to this project can be attached.
  const attachments = await resolveAttachments(id, attachmentIds ?? []);

  // A free fix has to be what it says: the generated prompt for a real error,
  // nothing else attached, and only a few a day per person. Otherwise it runs
  // as a normal turn that uses credits.
  const free = freeFix ? await freeFixAllowed(user.id, content, attachments.length) : null;

  try {
    if (!free?.ok) await assertCredits(project.workspaceId, { userId: user.id, projectId: id });
  } catch (err) {
    if (err instanceof InsufficientCredits) {
      return Response.json(
        { error: "Out of credits", balance: err.balance },
        { status: 402 },
      );
    }
    if (err instanceof SpendLimitReached) {
      const m = await db.membership.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: project.workspaceId } },
      });
      const admin = m?.role === "OWNER" || m?.role === "ADMIN";
      const what = { workspace: "this workspace's", user: "your", project: "this project's" }[err.scope];
      return Response.json(
        {
          error: `You've reached ${what} monthly spending limit (${err.limit} credits).`,
          hint: admin
            ? "Raise or remove it in Settings → Billing → Manage limits."
            : "Ask a workspace owner or admin to raise the limit.",
          limit: err.limit,
          scope: err.scope,
        },
        { status: 402 },
      );
    }
    throw err;
  }

  const userMessage = await db.message.create({
    data: {
      projectId: id,
      userId: user.id,
      role: "USER",
      content,
      mode: chosen,
      attachments: attachments.length ? attachments : undefined,
      chatId: chatId || null,
    },
  });
  const assistantMessage = await db.message.create({
    data: { projectId: id, role: "ASSISTANT", content: "", mode: chosen, chatId: chatId || null },
  });
  const build = await db.build.create({
    data: {
      projectId: id,
      messageId: assistantMessage.id,
      status: "QUEUED",
      mode: buildMode,
      goalRemaining: chosen === "goal" ? GOAL_TURNS : null,
      free: !!free?.ok,
    },
  });

  ensureWorker();
  if (!freeFix) countMessage(user.id, project.workspaceId);

  return Response.json(
    {
      buildId: build.id,
      userMessageId: userMessage.id,
      messageId: assistantMessage.id,
      ...(freeFix ? { free: !!free?.ok, freeReason: free?.reason ?? null } : {}),
    },
    { status: 202 },
  );
}

const FREE_FIXES_PER_DAY = 5;
const FIX_PREFIX = "Fix this error from the preview:\n\n";

/** Whether a "Try to fix" can run free: right shape, looks like an error, under the daily cap. */
async function freeFixAllowed(userId: string, content: string, attachments: number) {
  if (!content.startsWith(FIX_PREFIX) || attachments > 0 || content.length > 8000) {
    return { ok: false, reason: "Only the generated fix for a preview error can be free." };
  }
  const report = content.slice(FIX_PREFIX.length);
  if (!/(Error|Exception|Uncaught|undefined|null|failed|Cannot|is not)/.test(report)) {
    return { ok: false, reason: "That doesn't look like an error from the preview." };
  }
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const used = await db.message.count({ where: { userId, role: "USER", createdAt: { gte: today }, content: { startsWith: FIX_PREFIX } } });
  if (used >= FREE_FIXES_PER_DAY) {
    return { ok: false, reason: `You've used today's ${FREE_FIXES_PER_DAY} free fixes. Send it as a normal message to use credits.` };
  }
  return { ok: true, reason: null };
}

export const GET = route(GET_);
export const POST = route(POST_);
