/**
 * Company knowledge base (the "Read" app): articles with audiences, drafts
 * and archive; uploads (Markdown, Word, PDF); versions and restore; stale
 * reviews; search with access rules; the review queue (suggest, approve with
 * edits, reject); unanswered questions; AI answers with sources; the service
 * endpoint the workspace apps use; the Builder's per-project tags and agent
 * context; knowledge first (the pre-lookup every AI gets before acting, for a
 * Builder turn and AI Chat); permission switches and isolation.
 *   npx tsx scripts/test-knowledge.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { agentContext, builderKnowledge, consultBlock } from "../src/lib/kb";
import { assistantKnowledge } from "../src/lib/assistant";

const [devToken, usersPath] = process.argv.slice(2);
if (!devToken || !usersPath) {
  console.error("usage: npx tsx scripts/test-knowledge.mts <devToken> <test-users.json>");
  process.exit(2);
}
const users = JSON.parse(fs.readFileSync(usersPath, "utf8")) as Record<string, string>;
const BASE = "http://localhost:3000";
const OWNER = `authjs.session-token=${devToken}`;
let MEMBER = `authjs.session-token=${users["member@localhost"]}`;
const OUTSIDER = `authjs.session-token=${users["outsider@localhost"]}`;
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2"; // throwaway smoke-test project
const tag = `kb${Date.now().toString(36)}`;

let pass = 0, fail = 0;
function check(label: string, ok: boolean, extra: unknown = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && extra ? `  ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 400)}` : ""}`);
}
async function api(cookie: string, url: string, body?: unknown, method?: string) {
  const r = await fetch(BASE + url, { method: method ?? (body !== undefined ? "POST" : "GET"), headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
async function upload(cookie: string, files: { name: string; type: string; data: Buffer | string }[], fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new Blob([typeof f.data === "string" ? f.data : new Uint8Array(f.data)], { type: f.type }), f.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(`${BASE}/api/kb/upload`, { method: "POST", headers: { cookie }, body: fd });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

/** A tiny valid PDF with one line of text (offsets computed so pdf.js accepts it). */
function pdf(text: string) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
async function docx(paras: { text: string; style?: string }[]) {
  const z = new JSZip();
  z.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p>${p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : ""}<w:r><w:t>${p.text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}

const wsId = (await api(OWNER, "/api/workspace")).json.workspace.id as string;
MEMBER = `${MEMBER}; forge_ws=${wsId}`;
const ownerId = (await db.session.findFirst({ where: { sessionToken: devToken } }))!.userId;
const memberId = (await db.session.findFirst({ where: { sessionToken: users["member@localhost"] } }))!.userId;
const perms = (await api(OWNER, "/api/permissions?admin=1")).json;
const memberRole = (perms.roles as any[]).find((r) => r.builtin === "member").id as string;
const projBefore = await db.project.findUnique({ where: { id: PID }, select: { kbMode: true, kbTags: true } });

try {
  // ── Articles and validation
  const body = `Who ships what and when.\n\n# Lead time\nStandard dispatch lead time is 3 working days from payment. ${tag}\n\n# Packing\nCoils are strapped and wrapped in VCI paper.\n\n# Who to ask\nRavi in the warehouse.`;
  const a = await api(OWNER, "/api/kb", { title: `Dispatch process ${tag}`, kind: "sop", body, tags: ["dispatch", tag], reviewEveryDays: 90 });
  check("an editor publishes an article", a.status === 201 && a.json.doc.version === 1 && a.json.doc.tags.includes("dispatch"), a.json);
  const docId = a.json.doc.id as string;
  check("a title is required", (await api(OWNER, "/api/kb", { body: "x" })).status === 400);
  check("the type must be a known one", (await api(OWNER, "/api/kb", { title: "x", body: "y", kind: "memo" })).status === 400);
  check("review intervals are 7–1095 days", (await api(OWNER, "/api/kb", { title: "x", body: "y", reviewEveryDays: 2 })).status === 400);
  const chunks = await db.kbChunk.findMany({ where: { docId }, orderBy: { seq: "asc" } });
  check("it is split into passages at headings", chunks.length === 4 && chunks[1].heading === "Lead time" && chunks[3].heading === "Who to ask");
  check("a member can read it", (await api(MEMBER, `/api/kb/${docId}`)).json?.doc?.title === `Dispatch process ${tag}`);
  check("a member can't publish (by default)", (await api(MEMBER, "/api/kb", { title: `x ${tag}`, body: "y" })).status === 403);
  check("…or edit someone else's article", (await api(MEMBER, `/api/kb/${docId}`, { body: "hacked" }, "PATCH")).status === 403);
  check("…or delete it", (await api(MEMBER, `/api/kb/${docId}`, undefined, "DELETE")).status === 403);
  check("an outsider can't open it", (await api(OUTSIDER, `/api/kb/${docId}`)).status === 404);

  // ── Audiences, drafts, archive
  const adm = await api(OWNER, "/api/kb", { title: `Salary bands ${tag}`, body: `Band C is 9 to 12 lakh. ${tag}`, kind: "policy", audience: "admins", tags: [tag] });
  check("an admins-only article is hidden from members", !((await api(MEMBER, `/api/kb?tag=${tag}`)).json.docs as any[]).some((d) => d.id === adm.json.doc.id) && (await api(MEMBER, `/api/kb/${adm.json.doc.id}`)).status === 404);
  check("…and from their search", !((await api(MEMBER, `/api/kb/search?q=${encodeURIComponent("salary band")}`)).json.hits as any[]).some((h) => h.docId === adm.json.doc.id));
  check("…but admins find it", ((await api(OWNER, `/api/kb/search?q=${encodeURIComponent(`salary band ${tag}`)}`)).json.hits as any[]).some((h) => h.docId === adm.json.doc.id));
  check("a role audience needs at least one role", (await api(OWNER, "/api/kb", { title: `R ${tag}`, body: "x", audience: "roles" })).status === 400);
  const rl = await api(OWNER, "/api/kb", { title: `Member handbook ${tag}`, body: `Leave policy: 18 days. ${tag}`, audience: "roles", roleIds: [memberRole], tags: [tag] });
  check("people in a chosen role can read it", rl.status === 201 && (await api(MEMBER, `/api/kb/${rl.json.doc.id}`)).status === 200);
  const dr = await api(OWNER, "/api/kb", { title: `Draft pricing ${tag}`, body: `Draft price 99. ${tag}`, status: "draft", tags: [tag] });
  check("drafts are hidden from readers", (await api(MEMBER, `/api/kb/${dr.json.doc.id}`)).status === 404);
  check("…and from search, even for editors", !((await api(OWNER, `/api/kb/search?q=${encodeURIComponent(`draft price ${tag}`)}`)).json.hits as any[]).some((h) => h.docId === dr.json.doc.id));

  // ── Search
  const s1 = (await api(MEMBER, `/api/kb/search?q=${encodeURIComponent("how long is the dispatch lead time")}`)).json.hits as any[];
  check("search finds the right passage from a question", s1[0]?.docId === docId && s1[0]?.heading === "Lead time", s1.slice(0, 2));
  check("prefix words match (strap → strapped)", ((await api(MEMBER, `/api/kb/search?q=strap`)).json.hits as any[]).some((h) => h.docId === docId && h.heading === "Packing"));
  check("an outsider's search finds nothing here", ((await api(OUTSIDER, `/api/kb/search?q=${tag}`)).json.hits as any[] ?? []).length === 0);

  // ── Uploads
  const up = await upload(OWNER, [
    { name: `price-list-${tag}.md`, type: "text/markdown", data: `# Prices\nHR coil: 54,000 per tonne. ${tag}` },
    { name: `credit-terms-${tag}.docx`, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: await docx([{ text: "Credit terms", style: "Heading1" }, { text: `Distributors get 45 days credit. ${tag}` }]) },
    { name: `quality-${tag}.pdf`, type: "application/pdf", data: pdf(`Mill test certificates ship with every coil ${tag}`) },
    { name: "virus.exe", type: "application/octet-stream", data: "MZ" },
  ], { kind: "pricing", tags: tag });
  check("upload Markdown, Word and PDF in one go", up.status === 201 && up.json.docs.length === 3, up.json);
  check("unsupported files are listed as failed", up.json.failed?.length === 1 && up.json.failed[0].name === "virus.exe");
  const wordDoc = up.json.docs.find((d: any) => d.fileName?.endsWith(".docx"));
  check("Word headings become Markdown headings", (await db.kbDoc.findUnique({ where: { id: wordDoc.id } }))!.body.startsWith("# Credit terms"));
  check("PDF text is searchable", ((await api(OWNER, `/api/kb/search?q=${encodeURIComponent(`mill test certificates ${tag}`)}`)).json.hits as any[]).some((h) => h.title === `quality ${tag}`));
  check("members can't upload", (await upload(MEMBER, [{ name: "a.md", type: "text/markdown", data: "# x" }])).status === 403);

  // ── Versions, restore, stale
  const e1 = await api(OWNER, `/api/kb/${docId}`, { body: body.replace("3 working days", "5 working days") }, "PATCH");
  check("editing makes a new version", e1.json.doc.version === 2);
  const vs = (await api(OWNER, `/api/kb/${docId}/versions`)).json.versions as any[];
  check("the old version is kept", vs.length === 1 && vs[0].version === 1 && vs[0].body.includes("3 working days"));
  check("search sees the new text", ((await api(OWNER, `/api/kb/search?q=${encodeURIComponent("5 working days dispatch")}`)).json.hits as any[])[0]?.text.includes("5 working days"));
  const rs = await api(OWNER, `/api/kb/${docId}`, { restore: 1 }, "PATCH");
  check("restore an earlier version", rs.json.doc.version === 3 && (await db.kbDoc.findUnique({ where: { id: docId } }))!.body.includes("3 working days"));
  await db.kbDoc.update({ where: { id: docId }, data: { reviewedAt: new Date(Date.now() - 100 * 86400_000) } });
  check("an article past its review date is flagged", ((await api(OWNER, `/api/kb?stale=1&tag=${tag}`)).json.docs as any[]).some((d) => d.id === docId));
  await api(OWNER, `/api/kb/${docId}`, { reviewed: true }, "PATCH");
  check("marking it reviewed clears the flag", !((await api(OWNER, `/api/kb?stale=1&tag=${tag}`)).json.docs as any[]).some((d) => d.id === docId));

  // ── Review queue
  const sg = await api(MEMBER, "/api/kb/suggestions", { docId, title: "Express dispatch", body: "Express dispatch in 1 day costs 2,000 extra.", reason: "Customer call today" });
  check("a member suggests an update", sg.status === 201 && sg.json.suggestion.status === "pending" && sg.json.suggestion.mode === "append");
  check("reviewers are told in the bell", !!(await db.notification.findFirst({ where: { userId: ownerId, kind: "kb.suggestion", title: { contains: "Express dispatch" } } })));
  check("the suggester can't approve it", (await api(MEMBER, `/api/kb/suggestions/${sg.json.suggestion.id}`, { action: "approve" })).status === 403);
  check("they see their own suggestion", ((await api(MEMBER, "/api/kb/suggestions")).json.suggestions as any[]).some((x) => x.id === sg.json.suggestion.id));
  const ap = await api(OWNER, `/api/kb/suggestions/${sg.json.suggestion.id}`, { action: "approve", body: "Express dispatch in 1 working day costs 2,500 extra." });
  const after = await db.kbDoc.findUnique({ where: { id: docId } });
  check("approving (with an edit) adds it as a new version", ap.json.status === "approved" && after!.body.includes("## Express dispatch") && after!.body.includes("2,500") && after!.version === 4);
  check("the suggester hears it was approved", !!(await db.notification.findFirst({ where: { userId: memberId, kind: "kb.approved", title: { contains: "Express dispatch" } } })));
  check("a reviewed suggestion can't be reviewed again", (await api(OWNER, `/api/kb/suggestions/${sg.json.suggestion.id}`, { action: "reject" })).status === 400);
  const sg2 = await api(MEMBER, "/api/kb/suggestions", { title: `Holiday list ${tag}`, body: "Diwali: 3 days off." });
  const ap2 = await api(OWNER, `/api/kb/suggestions/${sg2.json.suggestion.id}`, { action: "approve", kind: "policy", tags: [tag] });
  check("approving a new-article suggestion creates the article", !!ap2.json.docId && (await db.kbDoc.findUnique({ where: { id: ap2.json.docId } }))?.kind === "policy");
  const sg3 = await api(MEMBER, "/api/kb/suggestions", { title: `Wrong ${tag}`, body: "nonsense" });
  check("reject a suggestion", (await api(OWNER, `/api/kb/suggestions/${sg3.json.suggestion.id}`, { action: "reject" })).json.status === "rejected");
  check("suggesting needs a title and text", (await api(MEMBER, "/api/kb/suggestions", { title: "" })).status === 400);

  // ── Unanswered questions and AI answers
  const nq = `What is the warranty on ${tag}zzq widgets`;
  const none = await api(MEMBER, "/api/kb/ask", { question: nq });
  check("a question nothing covers still gets a general answer, flagged as not covered", none.status === 200 && none.json.found === false && typeof none.json.answer === "string" && none.json.answer.length > 0, none.json);
  const gs = (await api(OWNER, "/api/kb/gaps")).json.gaps as any[];
  const gap = gs.find((g) => g.question === nq);
  check("…and lands in Unanswered", !!gap);
  check("members can't dismiss it", (await api(MEMBER, "/api/kb/gaps", { id: gap?.id })).status === 403);
  await api(OWNER, "/api/kb/gaps", { id: gap?.id });
  check("an editor dismisses it", !((await api(OWNER, "/api/kb/gaps")).json.gaps as any[]).some((g) => g.question === nq));
  const ans = await api(MEMBER, "/api/kb/ask", { question: `How many days is the standard dispatch lead time? (${tag})` });
  check("AI answers from the articles, citing sources", ans.status === 200 && ans.json.found && /3/.test(ans.json.answer) && /\[\d\]/.test(ans.json.answer) && ans.json.sources.some((x: any) => x.docId === docId), ans.json);

  // ── Service endpoint for the workspace apps
  const key = process.env.IOTX_SERVICE_KEY!;
  const svc = (b: unknown, k = key) => fetch(`${BASE}/api/iotx/kb`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": k }, body: JSON.stringify(b) });
  check("the service endpoint needs the key", (await svc({ userId: memberId, query: "dispatch" }, "wrong")).status === 403);
  const sv = await (await svc({ userId: memberId, ws: wsId, query: `salary band leave policy ${tag}` })).json();
  check("it returns only what that person may read", sv.hits.some((h: any) => h.docId === rl.json.doc.id) && !sv.hits.some((h: any) => h.docId === adm.json.doc.id) && sv.context.includes("[1]"), sv);
  const sc = await (await svc({ userId: memberId, ws: wsId, query: `How many leave days does the member handbook give ${tag}`, consult: true, tool: true })).json();
  check("the apps' knowledge-first lookup returns the ready block", sc.hits.some((h: any) => h.docId === rl.json.doc.id) && sc.context.startsWith("Company knowledge (") && sc.context.includes("search_company_knowledge"), sc);
  const ss = await (await svc({ userId: memberId, ws: wsId, query: `How many leave days does the member handbook give ${tag}`, consult: true, cite: false, shared: true })).json();
  check("…for output others see (shared), only articles any member may read", !ss.hits.some((h: any) => h.docId === rl.json.doc.id) && !ss.context.includes("Cite them"), ss);
  const sn = await (await svc({ userId: memberId, ws: wsId, query: `qqzz${tag} blorp`, consult: true })).json();
  check("…and says when nothing matched", sn.hits.length === 0 && sn.context.includes("nothing in the knowledge base matched this request"));

  // ── Builder: per-project tags and agent context
  await api(OWNER, `/api/projects/${PID}/kb`, { mode: "on" });
  check("projects use company knowledge by default", (await api(OWNER, `/api/projects/${PID}/kb`)).json.mode === "on");
  const ctx1 = await agentContext(PID, ownerId);
  check("the agent is told what the knowledge base holds", ctx1.includes("search_company_knowledge") && ctx1.includes(`• Dispatch process ${tag}`));
  check("…without inflating the remembered-facts count", !ctx1.split("\n").some((l) => l.trim().startsWith("- ")));

  // ── Knowledge first: the platform looks the request up before any AI acts
  const gapsBefore = await db.kbGap.count({ where: { workspaceId: wsId } });
  const bt = await builderKnowledge(PID, ownerId, { text: `Show the standard dispatch lead time on the order page ${tag}`, context: "Steel orders" });
  check("a Builder turn gets the matching passage before it acts", bt.hits[0]?.docId === docId && bt.context.includes("3 working days"), bt.hits.map((h) => h.title));
  check("…as numbered Company knowledge sources", bt.context.includes("Company knowledge (the platform searched") && /\n\[1\] "Dispatch process/.test(bt.context));
  check("…with how to use them (first for company facts, combine with general knowledge, cite [n], search for more, say when they conflict)", ["they come before general knowledge", "Combine them with your general knowledge", "Cite them as [n]", "call search_company_knowledge", "If they conflict with the request, say so rather than guess."].every((x) => bt.context.includes(x)));
  check("…at most 5 passages and about 6,000 characters", bt.hits.length <= 5 && bt.context.slice(bt.context.indexOf("Company knowledge (the platform")).length < 7000);
  check("…after the article index", bt.context.indexOf(`• Dispatch process ${tag}`) < bt.context.indexOf("Company knowledge (the platform"));
  check("passage bullets don't read as remembered facts", consultBlock([{ docId: "x", title: "T", kind: "sop", heading: "", text: "Steps:\n- one\n  - two", version: 1, updatedAt: new Date(), rank: 1 }]).split("\n").every((l) => !l.trim().startsWith("- ")));
  const bn = await builderKnowledge(PID, ownerId, { text: `Add a frobnicator zqxv${tag} widget` });
  check("when nothing matches, the model is told it was checked", bn.hits.length === 0 && bn.context.includes("nothing in the knowledge base matched this request"));
  check("the pre-lookup doesn't fill Unanswered", (await db.kbGap.count({ where: { workspaceId: wsId } })) === gapsBefore);
  const bm = await builderKnowledge(PID, memberId, { text: `What is salary band C ${tag}` });
  const bo = await builderKnowledge(PID, ownerId, { text: `What is salary band C ${tag}` });
  check("a member's Builder turn never gets an admins-only article", !bm.hits.some((h) => h.docId === adm.json.doc.id) && !bm.context.includes("9 to 12 lakh"), bm.hits.map((h) => h.title));
  check("…while an admin's does", bo.hits.some((h) => h.docId === adm.json.doc.id));
  const ac = await assistantKnowledge(memberId, wsId, `How many leave days does the member handbook give ${tag}?`);
  check("AI Chat gets the pre-lookup too, as the person", ac.hits.some((h) => h.docId === rl.json.doc.id) && ac.context.includes("Leave policy: 18 days") && ac.context.includes("search_company_knowledge"), ac.hits.map((h) => h.title));
  const am = await assistantKnowledge(memberId, wsId, `salary band C pay ${tag}`);
  check("…and never hands a member's AI Chat an admins-only article", !am.hits.some((h) => h.docId === adm.json.doc.id));
  check("…and says so when nothing matched", (await assistantKnowledge(memberId, wsId, `qqzz${tag} blorp`)).context.includes("nothing in the knowledge base matched this request"));

  check("choosing tags needs at least one", (await api(OWNER, `/api/projects/${PID}/kb`, { mode: "tags", tags: [] })).status === 400);
  await api(OWNER, `/api/projects/${PID}/kb`, { mode: "tags", tags: ["dispatch"] });
  const ctx2 = await agentContext(PID, ownerId);
  check("limited to tags, only those articles are offered", ctx2.includes(`Dispatch process ${tag}`) && !ctx2.includes(`Member handbook ${tag}`));
  const bt2 = await builderKnowledge(PID, ownerId, { text: `How many leave days does the member handbook give ${tag}` });
  check("…and the pre-lookup keeps to those tags", !bt2.hits.some((h) => h.docId === rl.json.doc.id));
  check("company knowledge can't be switched off", (await api(OWNER, `/api/projects/${PID}/kb`, { mode: "off" })).status === 400);
  await db.project.update({ where: { id: PID }, data: { kbMode: "off", kbTags: [] } });
  check("a project stored as off reads as on", (await api(OWNER, `/api/projects/${PID}/kb`)).json.mode === "on");
  const bt3 = await builderKnowledge(PID, ownerId, { text: `standard dispatch lead time ${tag}` });
  check("…and its agent still consults the knowledge base first", bt3.hits.some((h) => h.docId === docId) && bt3.context.includes("search_company_knowledge"));

  // ── Permission switches
  await api(OWNER, "/api/permissions", { action: "updateRole", roleId: memberRole, set: { "read.view": false } });
  check("with Read turned off for their role, members are refused", (await api(MEMBER, "/api/kb")).status === 403);
  const sv2 = await (await svc({ userId: memberId, ws: wsId, query: "dispatch" })).json();
  check("…and the apps' AI gets nothing for them", sv2.hits.length === 0);
  // This process caches permission decisions for 5 seconds (the server dropped its own on the change).
  await new Promise((r) => setTimeout(r, 5500));
  check("…nor does their AI Chat or Builder pre-lookup", (await assistantKnowledge(memberId, wsId, `standard dispatch lead time ${tag}`)).context === "" && (await builderKnowledge(PID, memberId, { text: `standard dispatch lead time ${tag}` })).context === "");
  await api(OWNER, "/api/permissions", { action: "resetRole", roleId: memberRole });
  await api(OWNER, "/api/permissions", { action: "updateRole", roleId: memberRole, set: { "read.publish": true } });
  const mp = await api(MEMBER, "/api/kb", { title: `Member wrote ${tag}`, body: "ok", tags: [tag] });
  check("turning on Write for members lets them publish", mp.status === 201);
  await api(OWNER, "/api/permissions", { action: "resetRole", roleId: memberRole });

  // ── Google Drive folders (the member, with a stand-in Google connection, against a Drive mock on :4799)
  const realConn = await db.googleConnection.findUnique({ where: { userId: memberId } });
  if (realConn) {
    console.log("SKIP Drive folders: the member has a real Google connection, which this test won't touch");
  } else {
    const FOLDER = `fold${tag}`;
    const drive: Record<string, { name: string; mimeType: string; modifiedTime: string; content: Buffer | string }> = {
      d1: { name: `Returns policy ${tag}`, mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T10:00:00.000Z", content: `# Returns\nDamaged coils can be returned within 7 days. ${tag}` },
      p1: { name: `Quality manual ${tag}.pdf`, mimeType: "application/pdf", modifiedTime: "2026-10-01T10:00:00.000Z", content: pdf(`Hardness is tested on every heat ${tag}`) },
      f1: { name: "Feedback form", mimeType: "application/vnd.google-apps.form", modifiedTime: "2026-10-01T10:00:00.000Z", content: "" },
    };
    const mock = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const json = (v: unknown, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.headers.authorization !== "Bearer at-kbtest") return json({ error: { message: "Invalid Credentials" } }, 401);
      if (u.pathname === "/drive/v3/files") return json({ files: Object.entries(drive).map(([id, f]) => ({ id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: String(Buffer.byteLength(f.content)) })) });
      const m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(u.pathname);
      if (m && m[1] === FOLDER) return json({ id: FOLDER, name: "Company SOPs", mimeType: "application/vnd.google-apps.folder" });
      if (m && m[1] === "notafolder1234") return json({ id: m[1], name: "x", mimeType: "application/vnd.google-apps.document" });
      if (m && drive[m[1]]) {
        if (m[2] || u.searchParams.get("alt") === "media") { res.writeHead(200); return res.end(drive[m[1]].content); }
        return json({ id: m[1], ...drive[m[1]] });
      }
      json({ error: { message: "not found" } }, 404);
    });
    await new Promise<void>((r) => mock.listen(4799, "127.0.0.1", () => r()));
    try {
      await api(OWNER, "/api/permissions", { action: "updateRole", roleId: memberRole, set: { "read.publish": true } });
      check("a folder needs Google Drive connected first", (await api(MEMBER, "/api/kb/sources", { folder: FOLDER })).status === 400);
      await db.googleConnection.create({ data: { userId: memberId, email: "member@gtest.dev", refresh: {}, accessToken: "at-kbtest", expiresAt: new Date(Date.now() + 3600_000), scopes: "https://www.googleapis.com/auth/drive" } });
      check("a link that isn't a folder is refused", (await api(MEMBER, "/api/kb/sources", { folder: "https://drive.google.com/drive/folders/notafolder1234" })).status === 400);
      check("…and so is text that isn't a link", (await api(MEMBER, "/api/kb/sources", { folder: "my sops" })).status === 400);
      const src = await api(MEMBER, "/api/kb/sources", { folder: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`, kind: "sop", tags: [tag, "drive"] });
      check("connecting a folder reads its files (Google Docs and PDFs)", src.status === 201 && src.json.added === 2 && src.json.failed.length === 1 && src.json.source.folderName === "Company SOPs", src.json);
      const sid = src.json.source.id as string;
      check("unreadable files are reported on the folder", /Feedback form/.test((await db.kbSource.findUnique({ where: { id: sid } }))!.lastError ?? ""));
      check("the same folder can't be added twice", (await api(MEMBER, "/api/kb/sources", { folder: FOLDER })).status === 409);
      const ret = await db.kbDoc.findFirst({ where: { sourceId: sid, externalId: "d1" } });
      check("articles keep the folder's type and tags", ret?.kind === "sop" && ret.tags.includes("drive") && ret.source === "drive");
      check("Drive articles are searchable", ((await api(OWNER, `/api/kb/search?q=${encodeURIComponent(`damaged coils returned ${tag}`)}`)).json.hits as any[]).some((h) => h.docId === ret?.id));
      check("syncing again with nothing changed changes nothing", (await api(MEMBER, `/api/kb/sources/${sid}`, {})).json.updated === 0);
      drive.d1 = { ...drive.d1, modifiedTime: "2026-10-20T10:00:00.000Z", content: `# Returns\nDamaged coils can be returned within 10 days. ${tag}` };
      delete drive.p1;
      const sy = await api(MEMBER, `/api/kb/sources/${sid}`, {});
      const ret2 = await db.kbDoc.findUnique({ where: { id: ret!.id } });
      check("a file changed in Drive becomes a new version", sy.json.updated === 1 && ret2!.version === 2 && ret2!.body.includes("10 days") && !!(await db.kbVersion.findFirst({ where: { docId: ret!.id, note: "Changed in Drive" } })));
      check("a file removed from the folder is archived", sy.json.archived === 1 && (await db.kbDoc.findFirst({ where: { sourceId: sid, externalId: "p1" } }))?.status === "archived");
      check("an outsider can't sync it", (await api(OUTSIDER, `/api/kb/sources/${sid}`, {})).status === 404);
      await api(MEMBER, `/api/kb/sources/${sid}?keep=1`, undefined, "DELETE");
      check("disconnecting can keep the articles", !(await db.kbSource.findUnique({ where: { id: sid } })) && (await db.kbDoc.findUnique({ where: { id: ret!.id } }))?.sourceId === null);
    } finally {
      await db.googleConnection.deleteMany({ where: { userId: memberId, accessToken: "at-kbtest" } });
      await db.kbSource.deleteMany({ where: { folderId: FOLDER } });
      await api(OWNER, "/api/permissions", { action: "resetRole", roleId: memberRole });
      await new Promise((r) => mock.close(r));
    }
  }

  // ── Archive and delete
  await api(OWNER, `/api/kb/${up.json.docs[0].id}`, { status: "archived" }, "PATCH");
  check("archived articles leave search", !((await api(OWNER, `/api/kb/search?q=${encodeURIComponent(`HR coil ${tag}`)}`)).json.hits as any[]).some((h) => h.docId === up.json.docs[0].id));
  check("an editor deletes an article", (await api(OWNER, `/api/kb/${dr.json.doc.id}`, undefined, "DELETE")).status === 200 && (await api(OWNER, `/api/kb/${dr.json.doc.id}`)).status === 404);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  await api(OWNER, "/api/permissions", { action: "resetRole", roleId: memberRole }).catch(() => {});
  if (projBefore) await db.project.update({ where: { id: PID }, data: projBefore });
  const ids = (await db.kbDoc.findMany({ where: { workspaceId: wsId, OR: [{ title: { contains: tag } }, { tags: { has: tag } }, { body: { contains: tag } }] }, select: { id: true } })).map((d) => d.id);
  await db.kbSuggestion.deleteMany({ where: { workspaceId: wsId, OR: [{ docId: { in: ids } }, { title: { contains: tag } }, { title: "Express dispatch" }, { title: { startsWith: "Wrong" } }] } });
  await db.kbDoc.deleteMany({ where: { id: { in: ids } } });
  await db.kbGap.deleteMany({ where: { workspaceId: wsId, question: { contains: tag } } });
  await db.notification.deleteMany({ where: { kind: { in: ["kb.suggestion", "kb.approved"] }, title: { contains: tag } } });
  await db.notification.deleteMany({ where: { kind: { in: ["kb.suggestion", "kb.approved"] }, title: { contains: "Express dispatch" } } });
  await db.$disconnect();
}
console.log(`\nKnowledge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
