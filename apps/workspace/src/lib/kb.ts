import { suiteCall } from "./suite";

/**
 * The company knowledge base lives in the suite (web/src/lib/kb.ts). Workspace
 * AI features ask it through POST /api/iotx/kb, as the person they act for, so
 * only articles that person may read come back. Never fails the caller: no
 * suite, no Read app or no match just means no company context.
 */
export type KbHit = { docId: string; title: string; kind: string; heading: string; text: string; /** The project's own (platform) knowledge: read-only, no article page to link to. */ platform?: boolean };

export async function companyKnowledge(user: { userId: string; ws: string }, query: string, limit = 5): Promise<{ hits: KbHit[]; context: string }> {
  const q = query.trim().slice(0, 300);
  if (q.length < 2) return { hits: [], context: "" };
  try {
    const r = await suiteCall<{ hits?: KbHit[]; context?: string }>("/api/iotx/kb", { body: { userId: user.userId, ws: user.ws, query: q, limit } });
    if (r.status !== 200) return { hits: [], context: "" };
    return { hits: r.data.hits ?? [], context: r.data.context ?? "" };
  } catch {
    return { hits: [], context: "" };
  }
}

/**
 * Knowledge first: the step every workspace AI takes before acting on a
 * request. The suite searches the knowledge base with the request (plus
 * context such as a meeting's title) as this person and returns a ready
 * "Company knowledge" block for the prompt: numbered sources and how to use
 * them, or a line saying nothing matched. One search, no model call.
 *   tool: the model has search_company_knowledge · cite: ask for [n] (default on)
 *   shared: others will see the output, so only articles any member may read
 */
export async function consultKnowledge(
  user: { userId: string; ws: string },
  request: string,
  o: { context?: string; tool?: boolean; cite?: boolean; shared?: boolean } = {},
): Promise<{ hits: KbHit[]; context: string }> {
  try {
    const r = await suiteCall<{ hits?: KbHit[]; context?: string }>("/api/iotx/kb", {
      body: { userId: user.userId, ws: user.ws, query: request.slice(0, 1000), consult: true, context: (o.context ?? "").slice(0, 300), tool: !!o.tool, cite: o.cite !== false, shared: !!o.shared },
    });
    if (r.status !== 200) throw new Error(`suite answered ${r.status}`);
    return { hits: r.data.hits ?? [], context: r.data.context ?? "" };
  } catch {
    return { hits: [], context: "Company knowledge: the knowledge base couldn't be checked for this request. Don't rely on company facts you weren't given." };
  }
}
