import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { bad } from "./http";

/**
 * Custom fields and issue templates for a project, and a small query
 * language for searching issues (like Jira's JQL):
 *   assignee = me AND status != Done AND labels in (frontend, seo) ORDER BY due ASC
 */

export type FieldDef = { id: string; name: string; type: "text" | "number" | "select" | "date" | "user" | "checkbox"; options?: string[] };
export type Template = { id: string; name: string; type: string; title: string; description: string; labels: string[]; priority: number };
const FTYPES = ["text", "number", "select", "date", "user", "checkbox"] as const;

export function cleanFieldDefs(input: unknown): FieldDef[] {
  if (!Array.isArray(input)) bad("Fields are a list.");
  const out: FieldDef[] = [];
  for (const raw of (input as Record<string, unknown>[]).slice(0, 30)) {
    const name = String(raw.name ?? "").trim().slice(0, 40);
    if (!name) bad("Every field needs a name.");
    if (out.some((f) => f.name.toLowerCase() === name.toLowerCase())) bad(`There are two fields called ${name}.`);
    const type = FTYPES.find((t) => t === raw.type) ?? "text";
    const id = typeof raw.id === "string" && /^f_[\w-]{4,40}$/.test(raw.id) ? raw.id : `f_${crypto.randomUUID().slice(0, 8)}`;
    const options = type === "select" ? [...new Set((Array.isArray(raw.options) ? raw.options : []).map((o) => String(o).trim().slice(0, 40)).filter(Boolean))].slice(0, 50) : undefined;
    if (type === "select" && !options?.length) bad(`${name}: add at least one option.`);
    out.push({ id, name, type, ...(options ? { options } : {}) });
  }
  return out;
}

/** Values from the client, checked against the project's fields (unknown keys dropped, empty removes). */
export function cleanCustom(input: unknown, defs: FieldDef[], prev: Record<string, unknown>, memberIds: string[]) {
  if (!input || typeof input !== "object") bad("Custom fields are an object of field id to value.");
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const f = defs.find((d) => d.id === k);
    if (!f) continue;
    if (v === null || v === "" || v === undefined) {
      delete out[k];
      continue;
    }
    if (f.type === "text") out[k] = String(v).slice(0, 2000);
    else if (f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) bad(`${f.name} must be a number.`);
      out[k] = n;
    } else if (f.type === "select") {
      if (!f.options?.includes(String(v))) bad(`${f.name}: pick one of ${f.options?.join(", ")}.`);
      out[k] = String(v);
    } else if (f.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) bad(`${f.name} must be a date (YYYY-MM-DD).`);
      out[k] = String(v);
    } else if (f.type === "user") {
      if (!memberIds.includes(String(v))) bad(`${f.name} must be someone in the project.`);
      out[k] = String(v);
    } else out[k] = v === true || v === "true";
  }
  return out;
}

export function cleanTemplates(input: unknown): Template[] {
  if (!Array.isArray(input)) bad("Templates are a list.");
  return (input as Record<string, unknown>[]).slice(0, 30).map((t) => {
    const name = String(t.name ?? "").trim().slice(0, 60);
    if (!name) bad("Every template needs a name.");
    return {
      id: typeof t.id === "string" && /^t_[\w-]{4,40}$/.test(t.id) ? t.id : `t_${crypto.randomUUID().slice(0, 8)}`,
      name,
      type: ["task", "bug", "story", "epic"].includes(String(t.type)) ? String(t.type) : "task",
      title: String(t.title ?? "").slice(0, 300),
      description: String(t.description ?? "").slice(0, 20000),
      labels: (Array.isArray(t.labels) ? t.labels : []).map((l) => String(l).trim().slice(0, 40)).filter(Boolean).slice(0, 20),
      priority: Math.max(0, Math.min(3, Math.round(Number(t.priority ?? 1)) || 0)),
    };
  });
}

// ── Query language ─────────────────────────────────────────────────────────

export class QueryError extends Error {}

type Tok = { t: "word" | "str" | "op" | "lp" | "rp" | "comma"; v: string };
function lex(q: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\()|(\))|(,)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(!=|>=|<=|!~|=|~|<|>)|([^\s(),=!<>~"']+))/y;
  let m: RegExpExecArray | null;
  let i = 0;
  while (i < q.length) {
    re.lastIndex = i;
    m = re.exec(q);
    if (!m || m[0].trim() === "") {
      if (q.slice(i).trim() === "") break;
      throw new QueryError(`I couldn't read the query near "${q.slice(i, i + 12)}".`);
    }
    i = re.lastIndex;
    if (m[1]) out.push({ t: "lp", v: "(" });
    else if (m[2]) out.push({ t: "rp", v: ")" });
    else if (m[3]) out.push({ t: "comma", v: "," });
    else if (m[4]) out.push({ t: "str", v: m[4].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (m[5]) out.push({ t: "op", v: m[5] });
    else out.push({ t: "word", v: m[6] });
  }
  return out;
}

const FIELDS = ["flagged", "fixversion", "component", "project", "key", "assignee", "reporter", "status", "statuscategory", "type", "priority", "labels", "label", "sprint", "epic", "due", "start", "created", "updated", "resolved", "text", "summary", "points", "watcher"];
const SORTS: Record<string, string> = { due: "due", created: "createdAt", updated: "updatedAt", priority: "priority", key: "number", rank: "position", summary: "title", points: "points", resolved: "completedAt" };
const PRI = ["low", "normal", "high", "urgent"];

export type QueryCtx = {
  me: string;
  resolveUser: (s: string) => string | null | undefined; // undefined = no such person
  statusIds: (name: string) => string[]; // status ids with that name or id across my projects
  categoryIds: (cat: string) => string[];
  projectIds: (s: string) => string[];
  /** Sprint ids by name or id; "open" and "active" (openSprints(), activeSprints()) too. */
  sprintIds: (s: string) => string[];
  epicIds: (s: string) => string[];
  versionIds: (s: string) => string[];
  componentIds: (s: string) => string[];
};

/** Parse the query into a Prisma filter and an order. */
export function parseQuery(q: string, c: QueryCtx): { where: Prisma.TaskWhereInput; orderBy: Prisma.TaskOrderByWithRelationInput[] } {
  const toks = lex(q);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isWord = (w: string) => peek()?.t === "word" && peek()!.v.toLowerCase() === w;

  const date = (v: string): Date => {
    const s = v.toLowerCase();
    const d = new Date();
    const today = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (s === "today" || s === "now()") return today;
    const rel = /^([+-]?\d+)([dw])$/.exec(s);
    if (rel) return new Date(today.getTime() + Number(rel[1]) * (rel[2] === "w" ? 7 : 1) * 86_400_000);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`);
    throw new QueryError(`"${v}" isn't a date. Use YYYY-MM-DD, today, -7d or +2w.`);
  };

  function value(): string {
    const t = next();
    if (!t || (t.t !== "word" && t.t !== "str")) throw new QueryError("A value is missing.");
    return t.v;
  }
  function list(): string[] {
    if (peek()?.t !== "lp") throw new QueryError('Lists go in brackets: in (a, b).');
    next();
    const out: string[] = [];
    while (peek() && peek()!.t !== "rp") {
      out.push(value());
      if (peek()?.t === "comma") next();
    }
    if (next()?.t !== "rp") throw new QueryError("A list is missing its closing bracket.");
    return out;
  }

  function clause(): Prisma.TaskWhereInput {
    if (peek()?.t === "lp") {
      next();
      const w = or();
      if (next()?.t !== "rp") throw new QueryError("A bracket isn't closed.");
      return w;
    }
    if (isWord("not")) {
      next();
      return { NOT: clause() };
    }
    const f = next();
    if (!f || f.t !== "word") throw new QueryError("Expected a field, like assignee or status.");
    const field = f.v.toLowerCase();
    if (!FIELDS.includes(field)) throw new QueryError(`I don't know the field "${f.v}". Try: ${FIELDS.filter((x) => x !== "label" && x !== "summary").join(", ")}.`);
    // is EMPTY / is not EMPTY
    if (isWord("is")) {
      next();
      const not = isWord("not") ? (next(), true) : false;
      const v = value().toLowerCase();
      if (v !== "empty" && v !== "null") throw new QueryError('Use "is empty" or "is not empty".');
      const col = { assignee: "assigneeId", epic: "epicId", sprint: "sprintId", due: "due", start: "start", points: "points", resolved: "completedAt", fixversion: "versionId" }[field];
      if (field === "component") return not ? { NOT: { componentIds: { isEmpty: true } } } : { componentIds: { isEmpty: true } };
      if (field === "flagged") return { flagged: not };
      if (field === "labels" || field === "label") return not ? { NOT: { labels: { isEmpty: true } } } : { labels: { isEmpty: true } };
      if (!col) throw new QueryError(`${f.v} can't be empty.`);
      return not ? { NOT: { [col]: null } } : { [col]: null };
    }
    let op: string;
    if (isWord("in")) {
      next();
      op = "in";
    } else if (isWord("not") && toks[pos + 1]?.v.toLowerCase() === "in") {
      pos += 2;
      op = "not in";
    } else {
      const o = next();
      if (!o || o.t !== "op") throw new QueryError(`After ${f.v}, write =, !=, in, ~, <, > …`);
      op = o.v;
    }
    const vals = op === "in" || op === "not in" ? list() : [value()];
    const neg = op === "!=" || op === "not in" || op === "!~";
    const wrap = (w: Prisma.TaskWhereInput): Prisma.TaskWhereInput => (neg ? { NOT: w } : w);
    const cmp = (col: string, isDate = true): Prisma.TaskWhereInput => {
      const v = isDate ? date(vals[0]) : Number(vals[0]);
      if (!isDate && !Number.isFinite(v as number)) throw new QueryError(`${f.v} needs a number.`);
      const k = { "<": "lt", "<=": "lte", ">": "gt", ">=": "gte", "=": "equals", "!=": "not" }[op];
      if (!k) throw new QueryError(`${f.v} compares with =, !=, <, <=, > or >=.`);
      if (isDate && (op === "=" || op === "!=") && col !== "due" && col !== "start") {
        const end = new Date((v as Date).getTime() + 86_400_000);
        return wrap({ [col]: { gte: v, lt: end } });
      }
      return { [col]: { [k]: v } };
    };
    switch (field) {
      case "text":
      case "summary":
        if (op !== "~" && op !== "!~") throw new QueryError(`Search text with ~, e.g. text ~ "checkout".`);
        return wrap(field === "summary" ? { title: { contains: vals[0], mode: "insensitive" } } : { OR: [{ title: { contains: vals[0], mode: "insensitive" } }, { description: { contains: vals[0], mode: "insensitive" } }] });
      case "assignee":
      case "reporter":
      case "watcher": {
        const ids = vals.map((v) => {
          const id = v.toLowerCase() === "me" || v.toLowerCase() === "currentuser()" ? c.me : c.resolveUser(v);
          if (id === undefined) throw new QueryError(`No one called "${v}" is in your projects.`);
          return id;
        });
        if (field === "watcher") return wrap({ OR: ids.map((id) => ({ watchers: { has: id ?? "" } })) });
        const col = field === "assignee" ? "assigneeId" : "createdBy";
        return wrap({ [col]: { in: ids.filter((x): x is string => !!x) } });
      }
      case "status":
        return wrap({ status: { in: vals.flatMap((v) => c.statusIds(v)) } });
      case "statuscategory":
        return wrap({ status: { in: vals.flatMap((v) => c.categoryIds(v.toLowerCase().replace(/\s+/g, "").replace("inprogress", "doing"))) } });
      case "type":
        return wrap({ type: { in: vals.map((v) => v.toLowerCase()) } });
      case "priority": {
        if (["<", ">", "<=", ">="].includes(op)) {
          const n = PRI.indexOf(vals[0].toLowerCase());
          if (n < 0) throw new QueryError("Priority is low, normal, high or urgent.");
          return { priority: { [{ "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" }[op]!]: n } };
        }
        const ns = vals.map((v) => PRI.indexOf(v.toLowerCase()));
        if (ns.some((n) => n < 0)) throw new QueryError("Priority is low, normal, high or urgent.");
        return wrap({ priority: { in: ns } });
      }
      case "labels":
      case "label":
        return wrap(op === "in" || op === "not in" ? { labels: { hasSome: vals } } : { labels: { has: vals[0] } });
      case "project":
        return wrap({ projectId: { in: vals.flatMap((v) => c.projectIds(v)) } });
      case "key": {
        const ors = vals.map((v) => {
          const m = /^([A-Za-z][A-Za-z0-9]{1,7})-(\d+)$/.exec(v);
          if (!m) throw new QueryError(`"${v}" isn't an issue key like WEB-12.`);
          return { number: Number(m[2]), projectId: { in: c.projectIds(m[1]) } };
        });
        return wrap({ OR: ors });
      }
      case "sprint": {
        return wrap({ sprintId: { in: vals.flatMap((v) => c.sprintIds(v)) } });
      }
      case "epic":
        return wrap({ epicId: { in: vals.flatMap((v) => c.epicIds(v)) } });
      case "fixversion":
        return wrap({ versionId: { in: vals.flatMap((v) => c.versionIds(v)) } });
      case "component":
        return wrap({ componentIds: { hasSome: vals.flatMap((v) => c.componentIds(v)) } });
      case "flagged": {
        const yes = ["true", "yes", "impediment"].includes(vals[0].toLowerCase());
        return wrap({ flagged: yes });
      }
      case "due":
        return cmp("due");
      case "start":
        return cmp("start");
      case "created":
        return cmp("createdAt");
      case "updated":
        return cmp("updatedAt");
      case "resolved":
        return cmp("completedAt");
      case "points":
        return cmp("points", false);
    }
    throw new QueryError(`I don't know the field "${f.v}".`);
  }

  function and(): Prisma.TaskWhereInput {
    const parts = [clause()];
    while (isWord("and")) {
      next();
      parts.push(clause());
    }
    return parts.length === 1 ? parts[0] : { AND: parts };
  }
  function or(): Prisma.TaskWhereInput {
    const parts = [and()];
    while (isWord("or")) {
      next();
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : { OR: parts };
  }

  let where: Prisma.TaskWhereInput = {};
  if (peek() && !isWord("order")) where = or();
  const orderBy: Prisma.TaskOrderByWithRelationInput[] = [];
  if (isWord("order")) {
    next();
    if (!isWord("by")) throw new QueryError('Write "ORDER BY field".');
    next();
    do {
      if (peek()?.t === "comma") next();
      const f = value().toLowerCase();
      const col = SORTS[f];
      if (!col) throw new QueryError(`I can't sort by "${f}". Try ${Object.keys(SORTS).join(", ")}.`);
      const dir = isWord("desc") ? (next(), "desc") : isWord("asc") ? (next(), "asc") : "asc";
      orderBy.push(col === "due" || col === "completedAt" || col === "points" ? { [col]: { sort: dir, nulls: "last" } } : { [col]: dir });
    } while (peek()?.t === "comma");
  }
  if (pos < toks.length) throw new QueryError(`I didn't understand "${toks.slice(pos).map((t) => t.v).join(" ")}". Join conditions with AND or OR.`);
  return { where, orderBy: orderBy.length ? orderBy : [{ updatedAt: "desc" }] };
}
