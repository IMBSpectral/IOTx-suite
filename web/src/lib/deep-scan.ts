import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db } from "./db";
import { headSha, listFiles, readFile } from "./repo";
import { charge, creditsForUsage } from "./credits";
import { setConfig } from "./security";
import { meteredFetch } from "./ai-meter";

/**
 * Deep scan: an AI security review of the whole codebase, on top of the
 * pattern checks. It looks for problems a rule can't see: missing ownership
 * checks, auth that only happens in the browser, data leaking between users,
 * unsafe trust in input. Findings join the security center as "deep:" rules
 * (so ignoring them and the publish gate work as for any finding); a new
 * deep scan replaces the last one's. It costs credits like a chat.
 */

const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Security scan") });
const MODEL = "claude-opus-5-5";
const MAX_CHARS = 240_000;

const Result = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
      file: z.string(),
      line: z.number().int(),
      detail: z.string(),
      fix: z.string(),
    }),
  ),
});
export type DeepScan = {
  at: string;
  sha: string;
  summary: string;
  count: number;
  credits: number;
  truncated: boolean;
};

const SYSTEM = `You are a security reviewer for a web app built with React + Vite and a backend of serverless functions and a Postgres-style database with access rules.

Review the code you are given for real, exploitable security problems that pattern matching would miss:
- authorization: reading or changing another user's data, missing ownership checks, admin features guarded only in the UI
- authentication done only in the browser, trusting client-supplied user ids or roles
- secrets or private data exposed to the browser, logged, or returned by APIs
- injection (SQL, HTML/XSS, command), unsafe redirects, SSRF, insecure file handling
- payment or webhook handlers that trust unverified input

Report only problems you can point to in the code, with the file and line. Don't report style issues, missing tests, or generic advice. Severity: CRITICAL = anyone can take over accounts or read everyone's data; HIGH = a user can reach other users' data or bypass a paywall; MEDIUM = needs unusual conditions; LOW = hardening. Write detail and fix in plain language for a non-expert, one or two sentences each. Return an empty list if you find nothing real.`;

/** Source worth reviewing: the app's own code first, generic UI kit last, assets never. */
async function sources(projectId: string) {
  const files = (await listFiles(projectId)).filter(
    (f) =>
      /\.(tsx?|jsx?|sql|html)$/.test(f) &&
      !f.startsWith("node_modules/") &&
      !f.includes(".min.") &&
      !f.startsWith("dist/"),
  );
  const rank = (f: string) =>
    f.startsWith("src/components/ui/")
      ? 2
      : /(cloud|functions|supabase|api|server|auth)/i.test(f)
        ? 0
        : 1;
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let used = 0;
  let truncated = false;
  const parts: string[] = [];
  for (const f of files) {
    const text = await readFile(projectId, f).catch(() => "");
    if (!text) continue;
    const numbered = text
      .split("\n")
      .map((l, i) => `${i + 1}| ${l}`)
      .join("\n");
    if (used + numbered.length > MAX_CHARS) {
      truncated = true;
      continue;
    }
    used += numbered.length;
    parts.push(`<file path="${f}">\n${numbered}\n</file>`);
  }
  return { text: parts.join("\n\n"), files: parts.length, truncated };
}

export class DeepScanError extends Error {}

export async function deepScan(
  projectId: string,
  userId: string,
): Promise<DeepScan> {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: project.workspaceId },
    select: { creditBalance: true },
  });
  if (ws.creditBalance <= 0)
    throw new DeepScanError(
      "A deep scan needs credits. Add credits in Settings → Billing.",
    );
  const src = await sources(projectId);
  if (!src.files) throw new DeepScanError("There's no code to scan yet.");

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32_000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(Result) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Review this app's code.${src.truncated ? " (Some generic files were left out to fit.)" : ""}\n\n${src.text}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  const text = response.content.find((b) => b.type === "text");
  const parsed =
    text && "text" in text ? Result.safeParse(JSON.parse(text.text)) : null;
  if (response.stop_reason === "refusal" || !parsed?.success)
    throw new DeepScanError("The deep scan couldn't finish. Try again.");

  const credits = creditsForUsage(
    response.usage.input_tokens,
    response.usage.output_tokens,
  );
  await charge(project.workspaceId, credits, "GENERATION", undefined, {
    category: "chat",
    userId,
    projectId,
  });

  const sha = await headSha(projectId).catch(() => "unknown");
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  const findings = parsed.data.findings.map((f) => ({
    rule: `deep:${slug(f.title)}`,
    severity: f.severity,
    file: f.file.slice(0, 300),
    line: Math.max(1, f.line),
    detail: `${f.title}. ${f.detail} Fix: ${f.fix}`.slice(0, 2000),
  }));
  // Ignored deep findings stay ignored; the rest are replaced.
  const ignored = await db.securityFinding.findMany({
    where: { projectId, ignored: true, rule: { startsWith: "deep:" } },
  });
  const fresh = findings.filter(
    (f) => !ignored.some((i) => i.rule === f.rule && i.file === f.file),
  );
  await db.securityFinding.deleteMany({
    where: { projectId, ignored: false, rule: { startsWith: "deep:" } },
  });
  if (fresh.length)
    await db.securityFinding.createMany({
      data: fresh.map((f) => ({ ...f, projectId, sha })),
    });

  const result: DeepScan = {
    at: new Date().toISOString(),
    sha,
    summary: parsed.data.summary.slice(0, 1000),
    count: fresh.length,
    credits,
    truncated: src.truncated,
  };
  await setConfig(projectId, { deepScan: result });
  return result;
}
