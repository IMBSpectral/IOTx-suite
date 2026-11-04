import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db } from "./db";
import { repoDir } from "./paths";
import { commit, listFiles, readFile, writeFiles } from "./repo";
import { currentDraftId } from "./drafts";
import { charge } from "./credits";
import { consultProject } from "./kb";
import { meteredFetch } from "./ai-meter";

/**
 * Quick edit: an instant change to one selected element, without an agent
 * turn. The element is traced to its source file, one fast model call
 * proposes exact search/replace edits for that file, and they are applied
 * and committed on whatever the preview shows (main or the open draft).
 * Anything bigger than one file's local edit is handed to the agent.
 */

const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}), fetch: meteredFetch("Quick edit") });
const MODEL = "claude-opus-5-5";
export const QUICK_EDIT_CREDITS = 1;

export class QuickEditError extends Error {
  constructor(
    public readonly code: "no_source" | "needs_agent" | "busy" | "no_change",
    message: string,
  ) {
    super(message);
  }
}

const SOURCE = /\.(tsx|jsx|ts|js|html|css)$/;

/**
 * The file that renders an element: the one containing its text, preferring
 * a line that also carries its classes. Null when nothing matches, e.g. text
 * that comes from data at runtime.
 */
export async function findSource(projectId: string, el: { selector: string; text: string }) {
  const files = (await listFiles(projectId)).filter(
    (f) => SOURCE.test(f) && (f.startsWith("src/") || f === "index.html") && !f.includes("components/ui/"),
  );
  const text = el.text.replace(/\s+/g, " ").trim().slice(0, 80);
  const classes = el.selector.split(".").slice(1).filter((c) => c.length > 1);
  let best: { file: string; score: number } | null = null;
  for (const file of files) {
    const src = await readFile(projectId, file).catch(() => "");
    let score = 0;
    if (text.length >= 3 && src.replace(/\s+/g, " ").includes(text)) score += 3;
    if (classes.length && src.split("\n").some((line) => classes.every((c) => line.includes(c)))) score += 2;
    if (score > (best?.score ?? 0)) best = { file, score };
  }
  return best?.file ?? null;
}

/** Where an element is defined: its file and the 1-based line that best matches it. */
export async function locateSource(projectId: string, el: { selector: string; text: string }) {
  const file = await findSource(projectId, el);
  if (!file) return null;
  const lines = (await readFile(projectId, file)).split("\n");
  const text = el.text.replace(/\s+/g, " ").trim().slice(0, 40);
  const classes = el.selector.split(".").slice(1).filter((c) => c.length > 1);
  const byText = text.length >= 3 ? lines.findIndex((l) => l.replace(/\s+/g, " ").includes(text)) : -1;
  const byClass = classes.length ? lines.findIndex((l) => classes.every((c) => l.includes(c))) : -1;
  const at = byText >= 0 ? byText : byClass;
  return { file, line: at >= 0 ? at + 1 : 1 };
}

const Plan = z.object({
  needsAgent: z.boolean(),
  reason: z.string(),
  edits: z.array(z.object({ find: z.string(), replace: z.string() })),
});

const SYSTEM = `You make one small, local edit to a React + Tailwind source file, for an element the user picked in the live preview.

Return edits as exact search/replace pairs on the file you are given. Each "find" must be copied character for character from the file and appear exactly once; keep it short but unique. Change only what the request needs, keep the code style, and never touch unrelated elements.

Set needsAgent to true (with no edits) when the request can't be done as a local edit of this one file: new features, new components or files, data or state changes, changes elsewhere on the page, or anything ambiguous. Put a one-sentence explanation in reason either way.`;

async function propose(file: string, source: string, el: { selector: string; text: string }, instruction: string, company = "") {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // A quick edit should feel instant; it's a small, well-specified change.
    output_config: { effort: "low", format: zodOutputFormat(Plan) },
    system: company ? `${SYSTEM}\n\n${company}` : SYSTEM,
    messages: [
      {
        role: "user",
        content: `File: ${file}\n\n<file>\n${source}\n</file>\n\nSelected element: ${el.selector}${
          el.text ? ` with text "${el.text.slice(0, 120)}"` : ""
        }\n\nRequest: ${instruction}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new QuickEditError("needs_agent", "This needs the agent.");
  }
  return { plan: response.parsed_output, usage: response.usage };
}

/** Undo record for "Undo last quick edit", kept beside the projects. */
const undoFile = (projectId: string) => path.join(path.dirname(repoDir("_")), "_quick", `${projectId}.json`);
type UndoRecord = { files: { path: string; before: string }[]; at: string; label: string };

async function saveUndo(projectId: string, rec: UndoRecord) {
  await fs.mkdir(path.dirname(undoFile(projectId)), { recursive: true });
  await fs.writeFile(undoFile(projectId), JSON.stringify(rec));
}

async function busy(projectId: string) {
  return (await db.build.count({ where: { projectId, status: "RUNNING" } })) > 0;
}

/** Record a commit as the head of what the preview shows: the open draft, or the project. */
async function recordHead(projectId: string, sha: string) {
  const draft = await currentDraftId(projectId);
  if (draft) await db.draft.update({ where: { id: draft }, data: { headSha: sha } });
  else await db.project.update({ where: { id: projectId }, data: { headSha: sha, updatedAt: new Date() } });
}

export async function quickEdit(opts: {
  projectId: string;
  workspaceId: string;
  userId: string;
  instruction: string;
  element: { selector: string; text: string };
}) {
  const { projectId } = opts;
  if (await busy(projectId)) throw new QuickEditError("busy", "Wait for the agent to finish, then try again.");
  const file = await findSource(projectId, opts.element);
  if (!file) throw new QuickEditError("no_source", "This element has no source location. Ask the agent instead.");

  const before = await readFile(projectId, file);
  // Knowledge first: a price or a term typed into an element is checked against the company's articles.
  const company = await consultProject(projectId, opts.userId, opts.instruction, { context: opts.element.text.slice(0, 120), cite: false });
  const { plan } = await propose(file, before, opts.element, opts.instruction, company.context);
  if (plan.needsAgent || plan.edits.length === 0) {
    throw new QuickEditError("needs_agent", plan.reason || "This needs the agent.");
  }
  let after = before;
  for (const e of plan.edits) {
    const at = after.indexOf(e.find);
    if (!e.find || at === -1 || after.indexOf(e.find, at + 1) !== -1) {
      throw new QuickEditError("needs_agent", "The change couldn't be placed precisely. This needs the agent.");
    }
    after = after.slice(0, at) + e.replace + after.slice(at + e.find.length);
  }
  if (after === before) throw new QuickEditError("no_change", "Nothing needed to change.");

  await writeFiles(projectId, [{ path: file, content: after }]);
  const sha = await commit(projectId, `Quick edit: ${opts.instruction.slice(0, 60)}`);
  await recordHead(projectId, sha);
  await saveUndo(projectId, { files: [{ path: file, before }], at: new Date().toISOString(), label: opts.instruction });
  await charge(opts.workspaceId, QUICK_EDIT_CREDITS, "GENERATION", undefined, {
    category: "build",
    userId: opts.userId,
    projectId,
  });
  return { file, sha, reason: plan.reason, edits: plan.edits.length };
}

/**
 * Pending text changes typed straight into the preview, sent as a batch.
 * Pure text replacement in source: no model call and no credits. A change
 * whose old text isn't found exactly once in one file is reported back.
 */
export async function applyTextChanges(projectId: string, changes: { oldText: string; newText: string }[]) {
  if (await busy(projectId)) throw new QuickEditError("busy", "Wait for the agent to finish, then try again.");
  const files = (await listFiles(projectId)).filter((f) => SOURCE.test(f) && (f.startsWith("src/") || f === "index.html"));
  const contents = new Map<string, string>();
  for (const f of files) contents.set(f, await readFile(projectId, f).catch(() => ""));
  const originals = new Map(contents);
  const applied: string[] = [];
  const failed: { oldText: string; reason: string }[] = [];

  for (const c of changes) {
    const oldText = c.oldText.replace(/\s+/g, " ").trim();
    if (!oldText || oldText === c.newText.trim()) continue;
    // JSX collapses line breaks and indentation in text to one space, so the
    // text the preview shows can span several source lines.
    const pattern = new RegExp(
      oldText
        .split(" ")
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
      "g",
    );
    const counts = [...contents].map(([f, src]) => [f, src.match(pattern)?.length ?? 0] as const);
    const total = counts.reduce((n, [, k]) => n + k, 0);
    if (total !== 1) {
      failed.push({ oldText, reason: total === 0 ? "Not found in the source (it may come from data)." : "Appears in more than one place." });
      continue;
    }
    const file = counts.find(([, k]) => k === 1)![0];
    contents.set(file, contents.get(file)!.replace(pattern, () => c.newText.trim()));
    applied.push(file);
  }
  const changed = [...contents].filter(([f, src]) => originals.get(f) !== src);
  if (!changed.length) return { applied: 0, failed };

  await writeFiles(projectId, changed.map(([p, content]) => ({ path: p, content })));
  const sha = await commit(projectId, `Edit text (${applied.length} ${applied.length === 1 ? "change" : "changes"})`);
  await recordHead(projectId, sha);
  await saveUndo(projectId, {
    files: changed.map(([p]) => ({ path: p, before: originals.get(p) ?? "" })),
    at: new Date().toISOString(),
    label: "Text changes",
  });
  return { applied: applied.length, failed, sha };
}

/** "Undo last quick edit": put the touched files back and commit that. */
export async function undoQuickEdit(projectId: string) {
  const raw = await fs.readFile(undoFile(projectId), "utf8").catch(() => null);
  if (!raw) throw new QuickEditError("no_change", "There's no quick edit to undo.");
  const rec = JSON.parse(raw) as UndoRecord;
  await writeFiles(projectId, rec.files.map((f) => ({ path: f.path, content: f.before })));
  const sha = await commit(projectId, `Undo quick edit: ${rec.label.slice(0, 60)}`);
  await recordHead(projectId, sha);
  await fs.rm(undoFile(projectId), { force: true });
  return { sha };
}
