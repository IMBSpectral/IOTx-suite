import { ensureMonitor } from "./monitoring";
import { deployIfChanged } from "./cloud-functions";
import { effectiveKnowledge } from "./memory";
import { builderKnowledge, ensureKbSync } from "./kb";

const withCompanyKnowledge = (k: string | null, company: string) => (company ? `${(k ?? "").trim()}\n\n${company}`.trim() : k);
import { ensureAutomations } from "./automations";
import { ensureHousekeeping } from "./housekeeping";
import { spendFreeChat } from "./credits";
import { enqueueTurn } from "./turns";
import { designSystemContext } from "./design-systems";
import { db } from "./db";
import { generate } from "./generate";
import { emit, forget, resetEvents } from "./events";
import { enforceInvariants } from "./invariants";
import { createDraft, checkoutDraft, foldOpenDrafts } from "./drafts";
import { openVariants } from "./variants";
import { repoDir } from "./paths";
import { commit, stageAll } from "./repo";
import { charge, creditsForUsage, freeBuildHour } from "./credits";
import type { Attachment } from "./uploads";
import { matchSkill, skillInstruction } from "./skills";
import { warmUp } from "./sandbox";
import { aiScope, noteAiContext } from "./ai-meter";

/**
 * A Postgres-backed build queue.
 *
 * Builds are claimed with SKIP LOCKED, so several workers can share one queue
 * without coordinating, and a build that outlives its originating request
 * keeps running. Progress is published through the event log rather than the
 * HTTP response, which is what lets a client reload mid-build and catch up.
 */

const POLL_MS = 1000;
const HEARTBEAT_MS = 10_000;
// A build whose heartbeat is older than this lost its worker.
const STALE_MS = 60_000;
const MAX_ATTEMPTS = 3;

// Next compiles route handlers into separate bundles and reloads modules in
// development, so several copies of this module can exist in one process. Each
// copy has a version; the newest to call ensureWorker owns the polling loop and
// older loops retire after their current build. One live loop, on current code.
const workerState = globalThis as { __forgeWorkerVersion?: string; __forgeWarm?: boolean };
const MODULE_VERSION = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const CANCEL_POLL_MS = 1500;
/** Builds this process runs at once, each for a different project (FORGE_WORKER_CONCURRENCY). */
const CONCURRENCY = Math.max(
  1,
  Number(process.env.FORGE_WORKER_CONCURRENCY) || 4,
);

/**
 * Atomically take one queued build. Returns null when the queue is empty.
 *
 * A project runs one build at a time — every build shares the project's git
 * working tree — so a project with a RUNNING build is skipped even when
 * another worker process could take it. Paused and deleted projects are
 * skipped too. Within a project, builds run in queuePos order (reordering and
 * "run now" set it), then oldest first.
 */
async function claimNext(): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "builds"
       SET "status" = 'RUNNING',
           -- A requeued build restarts from scratch, so "Worked for" counts this attempt only.
           "startedAt" = NOW(),
           "heartbeatAt" = NOW(),
           "attempts" = "attempts" + 1
     WHERE "id" = (
       SELECT b."id" FROM "builds" b
         JOIN "projects" p ON p."id" = b."projectId"
        WHERE b."status" = 'QUEUED'
          AND p."queuePaused" = false
          AND p."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "builds" r
             WHERE r."projectId" = b."projectId" AND r."status" = 'RUNNING'
          )
        ORDER BY b."queuePos", b."createdAt"
        FOR UPDATE OF b SKIP LOCKED
        LIMIT 1
     )
    RETURNING "id"
  `;
  return rows[0]?.id ?? null;
}

/**
 * Return builds abandoned by a dead worker to the queue.
 *
 * A process can die mid-build — a crash, a deploy, a dev-server reload — and
 * without this the row sits in RUNNING forever and every later build for that
 * project queues behind it. Attempts are capped so a build that reliably kills
 * its worker fails loudly instead of looping.
 */
async function recoverStale(): Promise<number> {
  const requeued = await db.$executeRaw`
    UPDATE "builds"
       SET "status" = 'QUEUED', "heartbeatAt" = NULL
     WHERE "status" = 'RUNNING'
       AND "attempts" < ${MAX_ATTEMPTS}
       AND COALESCE("heartbeatAt", "startedAt", "createdAt") < NOW() - (${STALE_MS} || ' milliseconds')::interval
  `;

  await db.$executeRaw`
    UPDATE "builds"
       SET "status" = 'FAILED',
           "endedAt" = NOW(),
           "error" = COALESCE("error", 'The build was interrupted and could not be resumed.')
     WHERE "status" = 'RUNNING'
       AND "attempts" >= ${MAX_ATTEMPTS}
       AND COALESCE("heartbeatAt", "startedAt", "createdAt") < NOW() - (${STALE_MS} || ' milliseconds')::interval
  `;

  return requeued;
}

/** The security center's notes ride along with the project's knowledge. */
function withSecurityMemory(knowledge: string | null, securityConfig: unknown) {
  const memory = (securityConfig as { memory?: string } | null)?.memory?.trim();
  if (!memory) return knowledge;
  const block = `Security requirements for this project:\n${memory}`;
  return knowledge?.trim() ? `${knowledge.trim()}\n\n${block}` : block;
}

async function runBuild(buildId: string) {
  const build = await db.build.findUnique({
    where: { id: buildId },
    include: { project: true },
  });
  if (!build?.messageId) return;

  const projectId = build.projectId;

  // Stopped while still queued: never start it.
  if (build.cancelRequested) {
    await db.build.update({
      where: { id: buildId },
      data: { status: "CANCELLED", endedAt: new Date() },
    });
    await emit(buildId, { type: "stopped" });
    await emit(buildId, {
      type: "done",
      sha: null,
      credits: 0,
      durationMs: 0,
      stopped: true,
    } as never);
    setTimeout(() => forget(buildId), 30_000);
    return;
  }

  // Everything up to this build's own assistant message. Messages queued after
  // it must not leak in: with a queue, "the newest user message in the
  // project" may belong to a later build.
  const own = await db.message.findUniqueOrThrow({
    where: { id: build.messageId },
    select: { createdAt: true, chatId: true },
  });
  const priorMessages = (
    await db.message.findMany({
      // Each chat is its own conversation.
      where: {
        projectId,
        chatId: own.chatId,
        id: { not: build.messageId },
        createdAt: { lte: own.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        role: true,
        content: true,
        userId: true,
        attachments: true,
        mode: true,
      },
    })
  ).reverse();

  // The instruction is this build's user turn; everything before it is history.
  const lastUser = [...priorMessages].reverse().find((m) => m.role === "USER");
  noteAiContext({ workspaceId: build.project.workspaceId, projectId, userId: lastUser?.userId ?? null });
  const instruction = lastUser?.content ?? "";
  const attachments = (lastUser?.attachments as Attachment[] | null) ?? [];
  // Variants are built in separate drafts, so one variant's turn must not see the others.
  const history = priorMessages
    .filter(
      (m) =>
        m !== lastUser &&
        !(lastUser?.mode === "variant" && m.mode === "variant"),
    )
    .map((m) => ({
      role: (m.role === "USER" ? "user" : "assistant") as "user" | "assistant",
      content: m.content || "(no response)",
    }));

  const knowledge = await db.knowledge.findUnique({ where: { projectId } });

  // This attempt owns the log. A reclaimed build replays from scratch, so
  // anything left by the worker that died is cleared first.
  await resetEvents(buildId);

  // Builds land in a draft, never directly on main. The draft is opened here
  // and checked out so every file the agent writes goes to its branch.
  // Read-only turns (ask, plan) change nothing, so they leave drafts and the
  // working tree alone entirely.
  const readOnly = build.mode === "ask" || build.mode === "plan";
  let draftId = readOnly ? null : build.draftId;
  // Remembered so a turn that ends up changing nothing can put the draft back.
  let draftWas: {
    status: "BUILDING" | "READY" | "FAILED" | "MERGED" | "REVERTED";
    created: boolean;
  } | null = null;
  // Review off (the default): the work goes straight into the working version and keeps going;
  // nothing reaches the live site until Publish. Drafts still open from before are folded in
  // first, so no earlier work is left behind. Variants keep their drafts (they're a choice in progress).
  const review = build.project.reviewDrafts || !!(await openVariants(projectId).catch(() => null));
  if (!draftId && !readOnly && !review && build.project.publishedSha) {
    if ((await stageAll(projectId).catch(() => 0)) > 0) {
      await commit(projectId, "Saved changes that hadn't been recorded").catch(() => undefined);
    }
    const { folded, stuck } = await foldOpenDrafts(projectId).catch(() => ({ folded: [] as string[], stuck: null }));
    if (folded.length) await emit(buildId, { type: "draft_ready", draftId: "", ok: true });
    if (stuck) {
      // Its changes clash with the working version: keep working in it rather than leave it behind.
      draftId = stuck;
      draftWas = { status: "READY", created: false };
      await db.$transaction([
        db.draft.update({ where: { id: stuck }, data: { status: "BUILDING" } }),
        db.build.update({ where: { id: buildId }, data: { draftId } }),
      ]);
    }
  }
  if (!draftId && !readOnly && review) {
    // A follow-up message continues the draft still under review — including
    // a failed one, which is exactly what "try to fix" needs. Only when no
    // draft is open does the work start a new branch from main.
    const open = await db.draft.findFirst({
      where: { projectId, status: { in: ["BUILDING", "READY", "FAILED"] } },
      orderBy: { updatedAt: "desc" },
    });
    if (open) {
      draftId = open.id;
      draftWas = { status: open.status, created: false };
      await db.$transaction([
        db.draft.update({
          where: { id: open.id },
          data: { status: "BUILDING" },
        }),
        db.build.update({ where: { id: buildId }, data: { draftId } }),
      ]);
    }
  }
  // Drafts keep changes away from a live app until they're accepted, so a
  // project that has never been published builds straight onto main.
  if (!draftId && !readOnly && review && build.project.publishedSha) {
    // The author is the person who asked — they've seen the draft by
    // definition, and collaborators get it flagged as a new arrival.
    draftWas = { status: "BUILDING", created: true };
    const d = await createDraft(
      projectId,
      lastUser?.userId ?? build.project.workspaceId,
      instruction.slice(0, 60) || "Untitled draft",
    );
    draftId = d.id;
    await db.build.update({ where: { id: buildId }, data: { draftId } });
    await emit(buildId, { type: "draft_opened", draftId, name: d.name });
  }
  // Anything in the working tree that was never committed (a command that edited files, an
  // install that changed package.json) would be wiped by the checkout: save it first, on the
  // branch it was made on.
  if (draftId && (await stageAll(projectId).catch(() => 0)) > 0) {
    await commit(projectId, "Saved changes that hadn't been recorded").catch(() => undefined);
  }
  if (draftId) await checkoutDraft(projectId, draftId);

  // Proof of life for the recovery sweep. Cleared in `finally` so a dead
  // worker stops reporting a build it is no longer running.
  const heartbeat = setInterval(() => {
    void db.build
      .update({ where: { id: buildId }, data: { heartbeatAt: new Date() } })
      .catch(() => undefined);
  }, HEARTBEAT_MS);

  let text = "";
  // touched: file changes, which decide whether there is anything to commit.
  // steps: everything the agent did, replayed as activity cards in chat.
  const touched: string[] = [];
  const steps: string[] = [];
  let inTok = 0;
  let outTok = 0;
  // Generated images are billed on top of tokens; they cost far more per call.
  let mediaCredits = 0;
  let failure: string | null = null;
  let verified = false;
  let stopped = false;
  // Out of credits mid-turn: the turn pauses (Resume / Finish up) instead of
  // running the balance far below zero.
  let outOfCredits = false;
  const balanceAtStart =
    build.free || readOnly
      ? Infinity
      : ((await db.workspace.findUnique({ where: { id: build.project.workspaceId }, select: { creditBalance: true } }))?.creditBalance ?? 0);
  const checkBalance = () => {
    if (outOfCredits || freeBuildHour()) return;
    if (creditsForUsage(inTok, outTok) + mediaCredits > balanceAtStart) {
      outOfCredits = true;
      abort.abort();
    }
  };
  const startedAt = Date.now();

  // Stop requests arrive as a flag on the row; polling it here keeps the
  // request handler free of any reference to the running generator.
  const abort = new AbortController();
  const cancelPoll = setInterval(() => {
    void db.build
      .findUnique({ where: { id: buildId }, select: { cancelRequested: true } })
      .then((b) => {
        if (b?.cancelRequested) abort.abort();
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);

  // "/skill-name …" runs a workspace skill: the agent gets its instructions for this turn.
  const skillUse = readOnly
    ? null
    : await matchSkill(build.project.workspaceId, instruction, lastUser?.userId).catch(
        () => null,
      );
  if (skillUse) {
    const step = `logs:Using skill /${skillUse.skill.name}`;
    steps.push(step);
    await emit(buildId, { type: "tool", step });
  }

  // Knowledge first: before the agent acts, the platform looks the request up
  // in the company knowledge base and hands it the top passages.
  const company = await builderKnowledge(projectId, lastUser?.userId ?? null, {
    text: skillUse ? `${skillUse.rest} ${skillUse.skill.title}` : instruction,
    context: build.project.name,
  }).catch(() => ({ hits: [], context: "" }));
  if (company.context) {
    const step = `logs:Checked company knowledge${company.hits.length ? ` (${company.hits.length} ${company.hits.length === 1 ? "passage" : "passages"})` : ": nothing matched"}`;
    steps.push(step);
    await emit(buildId, { type: "tool", step });
  }

  try {
    for await (const ev of generate({
      projectId,
      history,
      instruction: skillUse
        ? skillInstruction(skillUse.skill, skillUse.rest)
        : instruction,
      knowledge: withCompanyKnowledge(
        withSecurityMemory(
          await effectiveKnowledge(projectId, knowledge?.content ?? null, lastUser?.userId),
          build.project.securityConfig,
        ),
        company.context,
      ),
      userId: lastUser?.userId ?? null,
      mode: build.mode as "build" | "ask" | "design" | "plan",
      goal: build.goalRemaining != null,
      designSystem: await designSystemContext(projectId),
      signal: abort.signal,
      attachments,
    })) {
      if (ev.type === "stopped") stopped = true;
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "file") {
        const entry = `${ev.op}:${ev.path}`;
        if (!touched.includes(entry)) touched.push(entry);
        if (!steps.includes(entry)) steps.push(entry);
      } else if (ev.type === "tool") {
        if (!steps.includes(ev.step)) steps.push(ev.step);
      } else if (ev.type === "questions") {
        // Kept with the message so the question card survives a reload.
        steps.push(`questions:${JSON.stringify(ev.questions)}`);
      } else if (ev.type === "memory") {
        steps.push(`memory:${ev.fact}`);
      } else if (ev.type === "tasks") {
        const done = ev.tasks.filter((t) => t.status === "done").length;
        steps.push(`tasks:${done}/${ev.tasks.length}`);
      } else if (ev.type === "usage") {
        inTok = ev.inputTokens;
        outTok = ev.outputTokens;
        checkBalance();
      } else if (ev.type === "media_usage") {
        mediaCredits += ev.credits;
        checkBalance();
      } else if (ev.type === "build_completed") verified = ev.ok;
      else if (ev.type === "error") failure = ev.message;

      await emit(buildId, ev);
    }

    // Changes made by commands (scripts, installs) as well as by the file tools: all of them are
    // part of this version. Before, only write_file changes were committed and the rest vanished
    // at the next checkout (lost features, "removed 9 packages", Nov 2026).
    if (!readOnly && (await stageAll(projectId).catch(() => 0)) > 0 && !touched.some((t) => t.startsWith("write:"))) touched.push("write:(changes made by commands)");

    // Structural guarantees the model cannot be trusted to preserve. A
    // missing stylesheet import compiles cleanly and renders an unstyled
    // page, so verification never catches it.
    if (touched.length > 0) {
      const repairs = await enforceInvariants(repoDir(projectId));
      for (const r of repairs) {
        const entry = `write:${r.file}`;
        if (!touched.includes(entry)) touched.push(entry);
        if (!steps.includes(entry)) steps.push(entry);
        await emit(buildId, { type: "file", op: "write", path: r.file });
      }
    }

    let sha: string | null = null;
    // The version's name in history: the agent's title for it, else the request.
    const versionTitle = (() => {
      const raw = steps.find((st) => st.startsWith("report:"));
      try {
        const t = raw ? (JSON.parse(raw.slice("report:".length)) as { title?: string }).title : "";
        return t?.trim().slice(0, 72) || instruction.slice(0, 72) || "Update";
      } catch {
        return instruction.slice(0, 72) || "Update";
      }
    })();
    // The version is credited to the member who asked for it.
    const asker = lastUser?.userId ? await db.user.findUnique({ where: { id: lastUser.userId }, select: { name: true, email: true } }) : null;
    const author = asker ? { name: asker.name ?? asker.email.split("@")[0], email: asker.email } : null;
    if (touched.length > 0 && draftId) {
      sha = await commit(projectId, versionTitle, author);
      // The project's own head only moves when the draft is accepted. Work
      // from a stopped turn is kept, but marked unfinished.
      await db.draft.update({
        where: { id: draftId },
        data: {
          headSha: sha,
          status: stopped || failure || !verified ? "FAILED" : "READY",
        },
      });
      await emit(buildId, {
        type: "draft_ready",
        draftId,
        ok: !stopped && !failure && verified,
      });
    } else if (touched.length > 0) {
      // No draft (not published yet, or review is off): the change goes straight into the working version.
      sha = await commit(projectId, versionTitle, author);
      await db.project.update({ where: { id: projectId }, data: { headSha: sha, updatedAt: new Date() } });
      // Server functions go live with the code that calls them.
      await deployIfChanged(projectId).catch(() => undefined);
    } else if (draftId && draftWas) {
      // Nothing was written, so the draft goes back to where the turn found
      // it. A draft with no work in it at all — opened for this turn, or left
      // empty by an earlier interrupted one — is removed rather than kept as
      // an empty shell, and the working tree returns to main.
      const current = await db.draft.findUnique({
        where: { id: draftId },
        select: { headSha: true },
      });
      if (draftWas.created || !current?.headSha) {
        await checkoutDraft(projectId, null);
        await db.draft
          .delete({ where: { id: draftId } })
          .catch(() => undefined);
      } else {
        // BUILDING here is a leftover from an interrupted turn, not a state
        // worth restoring: the draft has work in it, so it is ready to review.
        const status =
          draftWas.status === "BUILDING" ? "READY" : draftWas.status;
        await db.draft
          .update({ where: { id: draftId }, data: { status } })
          .catch(() => undefined);
      }
      await emit(buildId, { type: "draft_ready", draftId, ok: true });
    }

    // Tokens already spent are charged even when the turn was stopped.
    // Security fixes are free, as on Lovable.
    // Charged as two rows, so usage splits into build/chat and media.
    const credits = build.free
      ? 0
      : creditsForUsage(inTok, outTok) + mediaCredits;
    const who = { userId: lastUser?.userId, projectId };
    // Ask and Plan turns are free up to a daily allowance per person
    // ("Your free daily chat allowance … resets at midnight UTC").
    const freeChat =
      readOnly &&
      !!who.userId &&
      (await spendFreeChat(
        build.project.workspaceId,
        who.userId,
        projectId,
        build.messageId,
      ));
    if (!build.free) {
      await charge(
        build.project.workspaceId,
        freeChat ? 0 : credits - mediaCredits,
        "GENERATION",
        build.messageId,
        {
          ...who,
          category: readOnly ? "chat" : "build",
        },
      );
      await charge(
        build.project.workspaceId,
        mediaCredits,
        "GENERATION",
        build.messageId,
        { ...who, category: "media" },
      );
    }

    const durationMs = Date.now() - startedAt;
    // The reply as saved. It also rides on "done": the live text deltas aren't replayed, so a
    // page that started listening late (a fast Ask reply) would otherwise show nothing until reload.
    const finalContent = outOfCredits ? text : stopped ? `${text}\n\n*Stopped.*`.trim() : text;
    await db.$transaction([
      db.message.update({
        where: { id: build.messageId },
        data: {
          content: finalContent,
          steps: outOfCredits ? [...steps, "paused:credits"] : steps,
        },
      }),
      db.build.update({
        where: { id: buildId },
        data: {
          status: stopped
            ? "CANCELLED"
            : failure || !verified
              ? "FAILED"
              : "SUCCEEDED",
          error: stopped ? null : failure,
          sha,
          creditsUsed: freeChat ? mediaCredits : credits,
          inputTokens: inTok,
          outputTokens: outTok,
          endedAt: new Date(),
        },
      }),
    ]);

    await emit(buildId, {
      type: "done",
      sha,
      credits: freeChat ? mediaCredits : credits,
      freeChat,
      durationMs,
      files: touched,
      verified,
      stopped,
      content: finalContent,
    } as never);

    // Goal runs keep going on their own while the task list has work left.
    if (
      build.goalRemaining != null &&
      build.goalRemaining > 1 &&
      !stopped &&
      !failure &&
      verified &&
      lastUser?.userId
    ) {
      const project = await db.project.findUnique({
        where: { id: projectId },
        select: { tasks: true },
      });
      const tasks = (project?.tasks as { status: string }[] | null) ?? [];
      if (tasks.some((t) => t.status !== "done")) {
        await enqueueTurn({
          projectId,
          userId: lastUser.userId,
          content:
            "Continue the goal: work on the next unfinished task in the task list.",
          messageMode: "goal_run",
          goalRemaining: build.goalRemaining - 1,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Build failed";
    await db.build.update({
      where: { id: buildId },
      data: { status: "FAILED", error: message, endedAt: new Date() },
    });
    await emit(buildId, { type: "error", message });
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    // Give a reconnecting client a moment to drain before dropping fan-out.
    setTimeout(() => forget(buildId), 30_000);
  }
}

/**
 * Start the polling loop once per process. Safe to call from every request:
 * the `running` guard makes repeat calls no-ops.
 */
export function ensureWorker() {
  ensureMonitor();
  // Build the shared node_modules template early, so the first project's boot is warm.
  if (!workerState.__forgeWarm) {
    workerState.__forgeWarm = true;
    warmUp();
  }
  ensureAutomations();
  ensureHousekeeping();
  ensureKbSync();
  if (workerState.__forgeWorkerVersion === MODULE_VERSION) return;
  workerState.__forgeWorkerVersion = MODULE_VERSION;

  let sinceSweep = 0;
  let active = 0;
  let scheduled = false;
  // Only one pass claims at a time: two overlapping claims could both take a
  // build of the same project before either is marked RUNNING.
  let claiming = false;
  const current = () => workerState.__forgeWorkerVersion === MODULE_VERSION;

  const tick = async () => {
    if (!current()) return; // superseded by a newer copy of this module
    try {
      // Sweep before claiming so an orphaned build is returned to the queue
      // rather than blocking everything behind it.
      if (sinceSweep <= 0) {
        await recoverStale();
        sinceSweep = 30;
      }
      sinceSweep--;

      // Several projects build at once; claimNext keeps it to one per project.
      // Claims happen one after another here, so two never race in this process.
      while (current() && active < CONCURRENCY && !claiming) {
        claiming = true;
        const id = await claimNext().finally(() => {
          claiming = false;
        });
        if (!id) break;
        active++;
        void aiScope(() => runBuild(id))
          .catch(() => undefined)
          .finally(() => {
            active--;
            // A slot opened: look for the next queued build straight away.
            if (current()) void tick();
          });
      }
    } catch {
      // A failed poll must not kill the loop; the next tick retries.
    } finally {
      // One poll timer at a time, however often a finished build calls tick.
      if (current() && !scheduled) {
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          void tick();
        }, POLL_MS);
      }
    }
  };

  void tick();
}
