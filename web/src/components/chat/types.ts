export type Attachment = { id: string; name: string; type: string; size: number };

export type TurnStatus = "queued" | "running" | "done" | "failed" | "stopped";

/** "goal" runs as Build, then keeps working through the task list on its own. */
export type Mode = "build" | "plan" | "ask" | "design" | "goal";

export type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Activity steps, e.g. "write:src/App.tsx", "read:…", "questions:[…]". */
  files: string[];
  mode?: Mode;
  buildId?: string;
  status?: TurnStatus;
  credits?: number;
  durationMs?: number;
  sha?: string | null;
  undone?: boolean;
  feedback?: "up" | "down" | null;
  attachments?: Attachment[];
};

export type Task = { title: string; status: "todo" | "in_progress" | "blocked" | "done" };

export function turnStatus(buildStatus?: string | null): TurnStatus | undefined {
  switch (buildStatus) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "done";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "stopped";
    default:
      return undefined;
  }
}

export function formatDuration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export type Step =
  | { kind: "write" | "delete" | "read"; path: string }
  | { kind: "logs"; detail: string }
  | { kind: "paused"; detail: string }
  | { kind: "memory"; detail: string }
  | { kind: "tasks"; detail: string }
  | { kind: "questions"; questions: { question: string; options?: string[] }[] }
  | { kind: "cloud"; detail: string; auto: boolean }
  | { kind: "credits"; ask: "buy" | "limit"; reason: string; amount: number | null }
  | { kind: "skill"; name: string; title: string; description: string; instructions: string }
  | { kind: "permission"; key: string; connection: string; tool: string; source: "connector" | "mcp" }
  | { kind: "vault"; site: string }
  | { kind: "migration"; id: string; detail: string }
  | { kind: "secret"; name: string; detail: string }
  | { kind: "switch"; detail: string }
  | { kind: "changeset"; id: string; detail: string }
  | { kind: "project"; id: string; detail: string }
  | { kind: "moved"; id: string; detail: string }
  | { kind: "visual"; id: string; detail: string }
  | { kind: "document"; id: string; detail: string }
  | { kind: "report"; title: string; changed: string[]; checked: string; next: string[] }
  | { kind: "call"; tool: string; input: string; output: string; failed: boolean; checkpoint?: string }
  | { kind: "thinking"; ms: number; text: string };

export function parseStep(raw: string): Step | null {
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const kind = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (kind === "write" || kind === "delete" || kind === "read") return { kind, path: rest };
  if (kind === "logs" || kind === "memory" || kind === "tasks") return { kind, detail: rest };
  // paused:credits: the turn stopped because the workspace ran out of credits.
  if (kind === "paused") return { kind, detail: rest };
  // cloud:request:<reason> · migration:<id>:<description> · secret:<NAME>:<description>
  // cloud:request:<reason> asks for approval; cloud:enabled:<reason> means the agent turned it on.
  if (kind === "cloud") return { kind, detail: rest.replace(/^(request|enabled):/, ""), auto: rest.startsWith("enabled:") };
  if (kind === "switch") return { kind, detail: rest };
  // credits:{"k":"buy"|"limit","r":reason,"n":amount} — the agent asks for credits or a higher limit
  // skill:{name,title,description,instructions} — a reusable skill the agent proposes
  // vault:<site> — the agent needs a saved login for a site
  if (kind === "vault") return { kind, site: rest };
  // permission:{key,connection,tool,kind} — a connector or MCP call waiting for the user's approval
  if (kind === "permission") {
    try {
      const j = JSON.parse(rest);
      return { kind, key: String(j.key ?? ""), connection: String(j.connection ?? ""), tool: String(j.tool ?? ""), source: j.kind === "mcp" ? "mcp" : "connector" };
    } catch {
      return null;
    }
  }
  if (kind === "credits" || kind === "skill") {
    try {
      const j = JSON.parse(rest);
      if (kind === "credits") return { kind, ask: j.k === "limit" ? "limit" : "buy", reason: String(j.r ?? ""), amount: typeof j.n === "number" ? j.n : null };
      return { kind, name: String(j.name ?? ""), title: String(j.title ?? ""), description: String(j.description ?? ""), instructions: String(j.instructions ?? "") };
    } catch {
      return null;
    }
  }
  // call:{"t":tool,"i":input,"o":output,"e":failed,"c":checkpoint} — one tool call, for the Input/Output cards
  // thinking:{"ms":…,"text":…} — the turn's summarized reasoning
  if (kind === "thinking") {
    try {
      const t = JSON.parse(rest) as { ms?: number; text?: string };
      return { kind, ms: Number(t.ms) || 0, text: t.text ?? "" };
    } catch {
      return null;
    }
  }
  if (kind === "call") {
    try {
      const c = JSON.parse(rest) as { t: string; i?: string; o?: string; e?: boolean; c?: string };
      return { kind, tool: c.t, input: c.i ?? "", output: c.o ?? "", failed: !!c.e, checkpoint: c.c };
    } catch {
      return null;
    }
  }
  if (kind === "report") {
    try {
      const r = JSON.parse(rest);
      return { kind, title: typeof r.title === "string" ? r.title : "", changed: r.changed ?? [], checked: r.checked ?? "", next: r.next ?? [] };
    } catch {
      return null;
    }
  }
  // changeset:<id>:<summary> — proposed ad campaign changes awaiting approval
  // project:<id>:<name> — a new project the agent created
  // visual:<id>:<title> — a visual explanation drawn for the user
  if (kind === "migration" || kind === "secret" || kind === "changeset" || kind === "project" || kind === "moved" || kind === "visual" || kind === "document") {
    const j = rest.indexOf(":");
    const head = j < 0 ? rest : rest.slice(0, j);
    const detail = j < 0 ? "" : rest.slice(j + 1);
    return kind === "secret" ? { kind, name: head, detail } : { kind, id: head, detail };
  }
  if (kind === "questions") {
    try {
      return { kind, questions: JSON.parse(rest) };
    } catch {
      return null;
    }
  }
  return null;
}
