/**
 * Quick edit over HTTP on a real project: an instant edit and its undo,
 * the no-source and needs-the-agent fallbacks, and batched text changes.
 * Makes real (small) model calls.
 *   npx tsx scripts/test-quick-edit.mts <devToken> <projectId>
 */
const BASE = "http://localhost:3000";
const [token, pid] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(path: string, json?: unknown, method = json === undefined ? "GET" : "POST") {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const Q = `/api/projects/${pid}/quick-edit`;
const file = async (p: string) => (await call(`/api/projects/${pid}/files?path=${encodeURIComponent(p)}`)).body.content as string;

async function main() {
  const t0 = Date.now();
  const edit = await call(Q, {
    action: "edit",
    instruction: "Change the heading text to: Hello from Forge",
    selector: "h1.mt-3.text-3xl.font-semibold",
    text: "Sandbox smoke test",
  });
  check("quick edit applied", edit.status === 200 && !!edit.body.file, `${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(edit.body).slice(0, 160)}`);
  if (edit.body.file) {
    const src = await file(edit.body.file);
    check("source has the new heading", src.includes("Hello from Forge"));
    const undo = await call(Q, { action: "undo" });
    check("undo last quick edit", undo.status === 200);
    const back = await file(edit.body.file);
    check("source restored", !back.includes("Hello from Forge") && back.includes("Sandbox smoke test"));
  }
  check("undo with nothing to undo", (await call(Q, { action: "undo" })).status === 422);

  const none = await call(Q, { action: "edit", instruction: "Make it red", selector: "div.nonexistent-class-xyz", text: "zzqq no such text" });
  check("no source location", none.status === 422 && none.body.code === "no_source", JSON.stringify(none.body));

  const big = await call(Q, {
    action: "edit",
    instruction: "Add a full user login system with a signup page, password reset and a database of users",
    selector: "h1.mt-3.text-3xl.font-semibold",
    text: "Sandbox smoke test",
  });
  check("big request needs the agent", big.status === 422 && big.body.code === "needs_agent", JSON.stringify(big.body).slice(0, 200));

  const para = "Describe what you want to build in the chat panel and this page will be replaced with it.";
  const text = await call(Q, { action: "text", changes: [
    { oldText: para, newText: "Tell Forge what to build." },
    { oldText: "text that is not anywhere", newText: "x" },
  ] });
  check("text changes: one applied, one reported", text.status === 200 && text.body.applied === 1 && text.body.failed.length === 1, JSON.stringify(text.body).slice(0, 200));
  await call(Q, { action: "undo" });
  check("text change undone", !(await call(`/api/projects/${pid}/files?path=src%2FApp.tsx`)).body.content?.includes("Tell Forge what to build."));
  check("empty instruction refused", (await call(Q, { action: "edit", instruction: " ", selector: "h1" })).status === 400);

  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
