import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./db";

/**
 * Claude usage, metered on the wire. Every Anthropic client is built with
 * `fetch: meteredFetch("Feature")`; each /v1/messages call is recorded in
 * ai_usage with the tokens Claude itself reported (streamed or not), the
 * model, and the dollar cost at Anthropic's list prices. Who it was for comes
 * from the request scope: route() opens one, requireUser and currentWorkspace
 * fill it in, and background jobs pass theirs to withAiContext.
 */

export type AiCtx = { workspaceId?: string | null; userId?: string | null; projectId?: string | null };
const scope = new AsyncLocalStorage<AiCtx>();

/** Runs fn with a fresh, fillable usage scope (one per request). */
export const aiScope = <T>(fn: () => T): T => scope.run({ ...scope.getStore() }, fn);

/** Runs fn with these ids attached to every Claude call inside it. */
export const withAiContext = <T>(ctx: AiCtx, fn: () => T): T => scope.run({ ...scope.getStore(), ...ctx }, fn);

/** Fills in the current scope (no-op outside one). */
export function noteAiContext(ctx: AiCtx) {
  const s = scope.getStore();
  if (s) for (const [k, v] of Object.entries(ctx)) if (v) (s as Record<string, unknown>)[k] = v;
}

// ── Prices: US dollars per million tokens (Anthropic list prices) ──
type Price = { input: number; output: number; cacheRead: number; long?: { above: number; input: number; output: number } };
const PRICES: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable-5|mythos-5/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5|opus-4/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5 } }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
];
/** Cache writes (5-minute) cost 1.25x input; each web search $10 per 1,000. */
const CACHE_WRITE = 1.25;
const PER_SEARCH = 0.01;

export type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number; searches: number };

/** Cost in millionths of a dollar. */
export function costMicros(model: string, u: Usage) {
  const p = PRICES.find(([re]) => re.test(model))?.[1];
  if (!p) return 0;
  const prompt = u.input + u.cacheWrite + u.cacheRead;
  const inP = p.long && prompt > p.long.above ? p.long.input : p.input;
  const outP = p.long && prompt > p.long.above ? p.long.output : p.output;
  const usd = (u.input * inP + u.cacheWrite * inP * CACHE_WRITE + u.cacheRead * p.cacheRead + u.output * outP) / 1e6 + u.searches * PER_SEARCH;
  return Math.round(usd * 1e6);
}

export type UsageRow = Usage & { app: string; feature: string; model: string; status: number; ms: number; requestId: string | null } & AiCtx;

export async function recordUsage(r: UsageRow) {
  await db.aiUsage
    .create({
      data: {
        workspaceId: r.workspaceId ?? null,
        userId: r.userId ?? null,
        projectId: r.projectId ?? null,
        app: r.app,
        feature: r.feature.slice(0, 60),
        model: r.model.slice(0, 80) || "unknown",
        status: r.status,
        inputTokens: r.input,
        outputTokens: r.output,
        cacheWriteTokens: r.cacheWrite,
        cacheReadTokens: r.cacheRead,
        webSearches: r.searches,
        costMicros: costMicros(r.model, r),
        ms: r.ms,
        requestId: r.requestId?.slice(0, 120) ?? null,
      },
    })
    .catch((e) => console.error("[ai-usage] not recorded:", e instanceof Error ? e.message : e));
}

type Raw = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number | null } | null };
const merge = (u: Usage, raw: Raw | undefined) => {
  if (!raw) return;
  u.input = Math.max(u.input, raw.input_tokens ?? 0);
  u.output = Math.max(u.output, raw.output_tokens ?? 0);
  u.cacheWrite = Math.max(u.cacheWrite, raw.cache_creation_input_tokens ?? 0);
  u.cacheRead = Math.max(u.cacheRead, raw.cache_read_input_tokens ?? 0);
  u.searches = Math.max(u.searches, raw.server_tool_use?.web_search_requests ?? 0);
};

/** Reads usage out of a Messages API response (JSON or a server-sent event stream). */
export async function usageOf(res: Response): Promise<{ model: string; usage: Usage }> {
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  let model = "";
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === "message_start") {
            model = ev.message?.model ?? model;
            merge(usage, ev.message?.usage);
          } else if (ev.type === "message_delta") merge(usage, ev.usage);
        } catch {}
      }
      if (done) break;
    }
  } else {
    const j = await res.json().catch(() => null);
    model = j?.model ?? "";
    merge(usage, j?.usage);
  }
  return { model, usage };
}

const isMessages = (url: string) => /\/v1\/messages(\?|$)/.test(url);

/** A fetch for the Anthropic SDK that records each Messages call under this feature. */
export function meteredFetch(feature: string, app = "suite"): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const started = Date.now();
    const res = await fetch(input, init);
    if (!isMessages(url)) return res;
    const ctx = { ...scope.getStore() };
    let asked = "";
    try {
      asked = JSON.parse(typeof init?.body === "string" ? init.body : "{}").model ?? "";
    } catch {}
    const requestId = res.headers.get("request-id");
    const done = (model: string, usage: Usage) =>
      recordUsage({ ...ctx, ...usage, app, feature, model: model || asked, status: res.status, ms: Date.now() - started, requestId });
    if (!res.ok || !res.body) {
      void done(asked, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 });
      return res;
    }
    const [mine, theirs] = res.body.tee();
    void usageOf(new Response(theirs, { headers: res.headers }))
      .then(({ model, usage }) => done(model, usage))
      .catch(() => undefined);
    return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
