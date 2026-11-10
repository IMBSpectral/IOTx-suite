/**
 * Insights: where an analysis lives on disk.
 *
 *   PROJECTS_ROOT/_insights/<workspaceId>/<analysisId>/
 *     meta.json      name, owner, sources, tables, board, chat
 *     files/         the files people added, as they were
 *     docs/<id>.txt  the text of documents (Word, PDF, slides, notes) for the AI to read
 *     data.duckdb    every table, ready for SQL
 *
 * Phase 1: an analysis belongs to the person who made it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_ROOT } from "../paths";

export type Source = {
  id: string;
  name: string;
  size: number;
  kind: "spreadsheet" | "csv" | "json" | "parquet" | "document" | "slides" | "pdf" | "text";
  at: string;
  /** Tables made from it. */
  tables: string[];
  /** Characters of text kept in docs/<id>.txt (documents). */
  textChars?: number;
  note?: string;
};

export type Table = {
  name: string;
  source: string;
  /** Sheet or table within the file. */
  part?: string;
  rows: number;
  columns: { name: string; type: string }[];
  /** Title rows above the headings in a sheet. */
  title?: string;
  /** Made by the AI from a document or a query. */
  derived?: boolean;
};

export type Widget = {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  /** Why it matters, in plain words. */
  insight?: string;
  sql?: string;
  /** Column roles for the chart (names of columns the SQL returns). */
  x?: string;
  y?: string[];
  series?: string;
  size?: number;
  /** Source column a click on this chart filters by ("Table.Column" or "Column"). */
  filter?: string;
  /** Insight cards: tone of the finding. */
  tone?: "good" | "bad" | "neutral" | "watch";
  /** KPI: how to show the number. */
  format?: "number" | "percent" | "currency" | "duration";
  unit?: string;
  options?: Record<string, unknown>;
};

export type ChatMsg = {
  role: "user" | "assistant";
  text: string;
  at: string;
  steps?: string[];
  questions?: string[];
};

export type Analysis = {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  tables: Table[];
  board: Widget[];
  chat: ChatMsg[];
  /** Questions the AI suggests next. */
  questions?: string[];
};

const safe = (s: string) => s.replace(/[^\w-]/g, "");
export const wsDir = (workspaceId: string) => path.join(PROJECTS_ROOT, "_insights", safe(workspaceId));
export const analysisDir = (workspaceId: string, id: string) => path.join(wsDir(workspaceId), safe(id));
export const dbFile = (a: Pick<Analysis, "workspaceId" | "id">) => path.join(analysisDir(a.workspaceId, a.id), "data.duckdb");
export const docFile = (a: Pick<Analysis, "workspaceId" | "id">, sourceId: string) => path.join(analysisDir(a.workspaceId, a.id), "docs", `${safe(sourceId)}.txt`);
export const sourceFile = (a: Pick<Analysis, "workspaceId" | "id">, s: Pick<Source, "id" | "name">) =>
  path.join(analysisDir(a.workspaceId, a.id), "files", `${safe(s.id)}-${s.name.replace(/[^\w.\- ]/g, "_").slice(-120)}`);

export class InsightsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// One write at a time per analysis: the chat, uploads and board edits all rewrite meta.json.
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  void next.finally(() => locks.get(id) === next && locks.delete(id)).catch(() => {});
  return next;
}

export async function listAnalyses(workspaceId: string, userId: string) {
  const dir = wsDir(workspaceId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Analysis[] = [];
  for (const n of names) {
    const a = await readMeta(workspaceId, n).catch(() => null);
    if (a && a.ownerId === userId) out.push(a);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readMeta(workspaceId: string, id: string): Promise<Analysis> {
  return JSON.parse(await fs.readFile(path.join(analysisDir(workspaceId, id), "meta.json"), "utf8"));
}

/** The analysis, if it's this person's. */
export async function getAnalysis(workspaceId: string, userId: string, id: string) {
  const a = await readMeta(workspaceId, id).catch(() => null);
  if (!a || a.ownerId !== userId) throw new InsightsError("Not found", 404);
  return a;
}

export async function saveAnalysis(a: Analysis) {
  a.updatedAt = new Date().toISOString();
  const dir = analysisDir(a.workspaceId, a.id);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `meta.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(a));
  await fs.rename(tmp, path.join(dir, "meta.json"));
  return a;
}

export async function createAnalysis(workspaceId: string, userId: string, name?: string) {
  const now = new Date().toISOString();
  const a: Analysis = {
    id: randomUUID(),
    workspaceId,
    ownerId: userId,
    name: name?.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled analysis",
    createdAt: now,
    updatedAt: now,
    sources: [],
    tables: [],
    board: [],
    chat: [],
  };
  await fs.mkdir(path.join(analysisDir(workspaceId, a.id), "files"), { recursive: true });
  await fs.mkdir(path.join(analysisDir(workspaceId, a.id), "docs"), { recursive: true });
  return saveAnalysis(a);
}

export async function deleteAnalysis(a: Analysis) {
  await fs.rm(analysisDir(a.workspaceId, a.id), { recursive: true, force: true });
}

/** A short summary for lists. */
export const summary = (a: Analysis) => ({
  id: a.id,
  name: a.name,
  updatedAt: a.updatedAt,
  sources: a.sources.length,
  tables: a.tables.length,
  widgets: a.board.length,
});
