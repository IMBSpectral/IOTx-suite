/**
 * Real terminal (PTY over the Docker API: input, output, resize, session
 * ownership), per-page link previews (routes, overrides served to crawlers,
 * sign-in / private / unpublished diagnostics), and per-tool-call
 * checkpoints with "Restore to here" (one live build turn).
 *   npx tsx scripts/test-cycle16.mts <devToken> <usersJson> <runningProjectId>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import http from "node:http";
import { db } from "../src/lib/db";
import { commit, listFiles, writeFiles } from "../src/lib/repo";

const BASE = "http://localhost:3000";
const [token, usersPath, runningPid] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const post = async (path: string, body: unknown, c = cookie) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const projects: string[] = [];

/** Collect terminal output until `until` matches or time runs out. */
async function readTerminal(pid: string, session: string, send: () => Promise<unknown>, until: RegExp, ms = 8000) {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/api/projects/${pid}/terminal?session=${session}`, { headers: { cookie }, signal: ctl.signal });
  const reader = res.body!.getReader();
  let text = "";
  let buf = "";
  const dec = new TextDecoder();
  await send();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until.test(text)) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 500))]);
    if (!r || r.done) continue;
    buf += dec.decode(r.value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const ev = JSON.parse(p.slice(6));
      if (ev.type === "data") text += Buffer.from(ev.b64, "base64").toString();
    }
  }
  ctl.abort();
  return text;
}

/** GET a published page like a crawler (Host header needs node:http). */
function crawl(host: string, path: string) {
  return new Promise<string>((ok, bad) => {
    http.get({ host: "127.0.0.1", port: 3000, path, headers: { host } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => ok(d));
    }).on("error", bad);
  });
}

try {
  // ── Real terminal ──
  const t = `/api/projects/${runningPid}/terminal`;
  const open = await post(t, { action: "open", cols: 120, rows: 40 });
  const session = String(open.json.session ?? "");
  check("a terminal opens in the running container", open.status === 200 && !!session, JSON.stringify(open.json));
  const out = await readTerminal(runningPid, session, () => post(t, { action: "input", session, data: "echo pty-$((6*7)); stty size; tty\r" }), /\/dev\/pts/);
  check("input runs in a shell with a TTY of the requested size", /pty-42/.test(out) && /40 120/.test(out) && /\/dev\/pts\/\d+/.test(out), JSON.stringify(out.slice(-160)));
  await post(t, { action: "resize", session, cols: 90, rows: 25 });
  const out2 = await readTerminal(runningPid, session, () => post(t, { action: "input", session, data: "stty size\r" }), /25 90/);
  check("resizing reaches the shell", /25 90/.test(out2));
  const stolen = await post(t, { action: "input", session, data: "echo no\r" }, `authjs.session-token=${users["member@localhost"]}`);
  check("someone else can't type into your terminal", stolen.status === 409 || stolen.status === 403, String(stolen.status));
  await post(t, { action: "close", session });
  const closed = await post(t, { action: "input", session, data: "x" });
  check("a closed terminal refuses input", closed.status === 409);

  // ── Per-page link previews ──
  const pid = ((await post("/api/projects", { name: "Cycle 16 pages", force: true })).json.project as { id: string }).id;
  projects.push(pid);
  await writeFiles(pid, [
    {
      path: "src/App.tsx",
      content: [
        'import { BrowserRouter, Route, Routes } from "react-router-dom";',
        "const Page = ({ name }: { name: string }) => <h1>{name}</h1>;",
        "const ProtectedRoute = ({ children }: { children: JSX.Element }) => children;",
        "export default function App() {",
        "  return (",
        "    <BrowserRouter>",
        "      <Routes>",
        '        <Route path="/" element={<Page name="Home" />} />',
        '        <Route path="/pricing" element={<Page name="Pricing" />} />',
        '        <Route path="/dashboard" element={<ProtectedRoute><Page name="Dashboard" /></ProtectedRoute>} />',
        '        <Route path="/blog/:slug" element={<Page name="Post" />} />',
        '        <Route path="*" element={<Page name="Not found" />} />',
        "      </Routes>",
        "    </BrowserRouter>",
        "  );",
        "}",
        "",
      ].join("\n"),
    },
  ]);
  await db.project.update({ where: { id: pid }, data: { headSha: await commit(pid, "Pages") } });
  const routes = async () => ((await (await fetch(`${BASE}/api/projects/${pid}/route-preview`, { headers: { cookie } })).json()).routes as { path: string; state: string; title: string; notes: string[] }[]) ?? [];
  const before = await routes();
  check("routes found in the source (home first, * left out)", before.map((r) => r.path).join(",") === "/,/blog/:slug,/dashboard,/pricing", before.map((r) => r.path).join(","));
  check("unpublished pages explain why there's no preview", before.every((r) => r.state === "unpublished"));

  const pub = await fetch(`${BASE}/api/projects/${pid}/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
  const last = (await pub.text()).split("\n\n").filter((p) => p.startsWith("data: ")).map((p) => JSON.parse(p.slice(6))).at(-1);
  check("published", last?.type === "published", JSON.stringify(last).slice(0, 160));
  const p = await db.project.findUniqueOrThrow({ where: { id: pid } });
  await fetch(`${BASE}/api/projects/${pid}/publish`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ audience: "public", seo: { title: "Cycle Shop", description: "Home description", pages: { "/pricing/": { title: "Pricing — Cycle Shop", description: "Plans & prices", ogImage: "/pricing.png" }, nope: { title: "x" } } } }),
  });
  const host = `${p.subdomain}.localhost:3000`;
  const pricingHtml = await crawl(host, "/pricing");
  const homeHtml = await crawl(host, "/");
  check("crawlers get the page's own title, description and image", /og:title" content="Pricing — Cycle Shop"/.test(pricingHtml) && /<title>Pricing — Cycle Shop<\/title>/.test(pricingHtml) && /og:description" content="Plans &amp; prices"/.test(pricingHtml) && /og:image" content="\/pricing.png"/.test(pricingHtml));
  check("other pages keep the site-wide card", /<title>Cycle Shop<\/title>/.test(homeHtml) && !/Pricing/.test(homeHtml));
  const seo = (await db.project.findUniqueOrThrow({ where: { id: pid } })).seo as { pages?: Record<string, unknown> };
  check("page keys are normalised; bad ones dropped", Object.keys(seo.pages ?? {}).join(",") === "/pricing");
  const after = await routes();
  const by = (path: string) => after.find((r) => r.path === path)!;
  check("the preview reads what crawlers get", by("/pricing").state === "ok" && by("/pricing").title === "Pricing — Cycle Shop" && by("/").title === "Cycle Shop");
  check("pages behind sign-in are flagged", by("/dashboard").state === "signin");
  check("pages sharing the home card are pointed out", by("/blog/:slug").notes.some((n) => /Same card as the home page/.test(n)) && by("/blog/:slug").notes.some((n) => /variable part/.test(n)));
  await fetch(`${BASE}/api/projects/${pid}/publish`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ audience: "private" }) });
  check("a private site explains that previews can't see it", (await routes()).every((r) => r.state === "private"));

  // ── Checkpoints per tool call (one live build turn) ──
  const cp = ((await post("/api/projects", { name: "Cycle 16 checkpoints", force: true })).json.project as { id: string }).id;
  projects.push(cp);
  const sent = (await post(`/api/projects/${cp}/messages`, {
    content: "Create two plain text files, in two separate write_file calls and in this order: notes/one.txt containing 'one', then notes/two.txt containing 'two'. Change nothing else and don't run anything.",
    mode: "build",
  })).json as { buildId: string; messageId: string };
  for (let i = 0; i < 120; i++) {
    const b = await db.build.findUnique({ where: { id: sent.buildId } });
    if (b && !["QUEUED", "RUNNING"].includes(b.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const reply = await db.message.findFirst({ where: { projectId: cp, role: "ASSISTANT" }, orderBy: { createdAt: "desc" } });
  const calls = ((reply?.steps as string[]) ?? []).filter((s) => s.startsWith("call:")).map((s) => JSON.parse(s.slice(5)) as { t: string; i: string; c?: string });
  const writeOne = calls.find((c) => c.t === "write_file" && c.i.includes("one.txt"));
  const reads = calls.filter((c) => c.t === "read_file");
  check("file-changing calls carry a checkpoint; read-only ones don't", !!writeOne?.c && reads.every((c) => !c.c), calls.map((c) => `${c.t}${c.c ? "+" : ""}`).join(" "));
  if (writeOne?.c) {
    const files0 = await listFiles(cp);
    const r = await post(`/api/projects/${cp}/revert`, { sha: writeOne.c, checkpoint: true });
    const files1 = await listFiles(cp);
    check("Restore to here: back to just after that step", r.status === 200 && files0.includes("notes/two.txt") && files1.includes("notes/one.txt") && !files1.includes("notes/two.txt"), files1.filter((f) => f.startsWith("notes")).join(","));
    const head = (await db.project.findUniqueOrThrow({ where: { id: cp } })).headSha;
    check("the restore is a new version on the branch", head === r.json.sha);
    const bogus = await post(`/api/projects/${cp}/revert`, { sha: "0".repeat(40), checkpoint: true });
    check("an unknown checkpoint is refused", bogus.status === 404, String(bogus.status));
  }
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of projects) {
    await db.build.updateMany({ where: { projectId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED" } });
    await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
