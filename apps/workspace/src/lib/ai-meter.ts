import { AsyncLocalStorage } from "node:async_hooks";
import { SUITE_URL } from "./env";

/**
 * Claude usage, metered on the wire and reported to the suite (web/
 * api/iotx/ai-usage), which keeps one usage log for the whole platform.
 * Every Anthropic client here is built with `fetch: meteredFetch("Feature")`;
 * who a call was for comes from the request scope that route() opens and
 * getMe() fills in.
 */

type Ctx = { workspaceId?: string | null; userId?: string | null };
const scope = new AsyncLocalStorage<Ctx>();

export const aiScope = <T>(fn: () => T): T => scope.run({ ...scope.getStore() }, fn);
export const withAiContext = <T>(ctx: Ctx, fn: () => T): T => scope.run({ ...scope.getStore(), ...ctx }, fn);
export function noteAiContext(ctx: Ctx) {
  const s = scope.getStore();
  if (s) for (const [k, v] of Object.entries(ctx)) if (v) (s as Record<string, unknown>)[k] = v;
}

type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number; searches: number };
type Row = Usage & Ctx & { feature: string; model: string; status: number; ms: number; requestId: string | null };

let queue: Row[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
function flush() {
  timer = null;
  const rows = queue.splice(0, 200);
  if (!rows.length) return;
  void fetch(`${SUITE_URL}/api/iotx/ai-usage`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-iotx-key": process.env.IOTX_SERVICE_KEY ?? "" },
    body: JSON.stringify({ rows }),
  })
    .then((r) => (r.ok ? undefined : console.error(`[ai-usage] suite answered ${r.status}`)))
    .catch((e) => console.error("[ai-usage] not reported:", e instanceof Error ? e.message : e));
  if (queue.length) timer = setTimeout(flush, 500);
}
function report(r: Row) {
  queue.push(r);
  if (queue.length > 1000) queue = queue.slice(-1000);
  timer ??= setTimeout(flush, 2000);
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

async function usageOf(res: Response) {
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

/** A fetch for the Anthropic SDK that reports each Messages call under this feature. */
export function meteredFetch(feature: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const started = Date.now();
    const res = await fetch(input, init);
    if (!/\/v1\/messages(\?|$)/.test(url)) return res;
    const ctx = { ...scope.getStore() };
    let asked = "";
    try {
      asked = JSON.parse(typeof init?.body === "string" ? init.body : "{}").model ?? "";
    } catch {}
    const requestId = res.headers.get("request-id");
    const done = (model: string, usage: Usage) => report({ ...ctx, ...usage, feature, model: model || asked, status: res.status, ms: Date.now() - started, requestId });
    if (!res.ok || !res.body) {
      done(asked, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 });
      return res;
    }
    const [mine, theirs] = res.body.tee();
    void usageOf(new Response(theirs, { headers: res.headers }))
      .then(({ model, usage }) => done(model, usage))
      .catch(() => undefined);
    return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
