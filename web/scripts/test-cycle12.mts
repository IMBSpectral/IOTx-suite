/**
 * Assistant context (chat files and earlier chats, one real assistant call),
 * ZIP inspection before import, and collections for @-mentions.
 *   npx tsx scripts/test-cycle12.mts <devToken>
 */
import "dotenv/config";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { inspectZip } from "../src/lib/zip-inspect";
import { getCollections, updateCollections } from "../src/lib/library";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
let pid = "";
const chatIds: string[] = [];

try {
  // ── ZIP inspection ──
  const zip = new JSZip();
  zip.file("shop/package.json", JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }));
  zip.file("shop/app/page.tsx", "export default function Page() { return null }");
  zip.file("shop/node_modules/react/index.js", "x");
  zip.file("shop/.git/HEAD", "ref");
  const blob = new Blob([new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }))]);
  const s = await inspectZip(blob);
  check("counts files, skips dependencies and .git", s.files === 2 && s.skipped === 2, JSON.stringify(s));
  check("detects the framework and warns it isn't Vite", s.framework === "Next.js" && s.warnings.some((w) => /Vite \+ React/.test(w)));
  const plain = new JSZip();
  plain.file("index.html", "<h1>hi</h1>");
  const p2 = await inspectZip(new Blob([new Uint8Array(await plain.generateAsync({ type: "nodebuffer" }))]));
  check("static site recognised", p2.framework === "Static site" && !p2.hasPackageJson);

  // ── Collections for @-mentions ──
  pid = ((await (await fetch(`${BASE}/api/projects`, json("POST", { name: "Cycle 12 test", force: true }))).json()) as { project: { id: string } }).project.id;
  await updateCollections(pid, { action: "create", name: "Brand photos" });
  const lib = await (await fetch(`${BASE}/api/projects/${pid}/library`, { headers: { cookie } })).json();
  check("collections listed for mentions", lib.collections?.some((c: { name: string }) => c.name === "Brand photos") && (await getCollections(pid)).length === 1);

  // ── Assistant with an earlier chat and a file as context ──
  const first = await (await fetch(`${BASE}/api/assistant`, json("POST", { content: "Remember this for later: our launch codename is BLUE HERON. Just reply OK." }))).json();
  const firstChat = first.chatId ?? first.chat?.id;
  if (firstChat) chatIds.push(firstChat);
  check("first assistant chat", !!firstChat, JSON.stringify(first).slice(0, 160));
  const form = new FormData();
  form.append("file", new Blob(["Pricing notes: the Pro plan costs 29 dollars a month."], { type: "text/plain" }), "pricing.txt");
  const up = (await (await fetch(`${BASE}/api/projects/${pid}/uploads`, { method: "POST", headers: { cookie }, body: form })).json()).attachments[0];
  const t0 = Date.now();
  const second = await (
    await fetch(
      `${BASE}/api/assistant`,
      json("POST", {
        content: "What is our launch codename, and how much does the Pro plan cost according to the file? Answer in one short sentence.",
        chatIds: firstChat ? [firstChat] : [],
        files: [{ projectId: pid, uploadId: up.id }],
      }),
    )
  ).json();
  const secondChat = second.chatId ?? second.chat?.id;
  if (secondChat) chatIds.push(secondChat);
  const reply = String(second.reply?.content ?? JSON.stringify(second));
  check("assistant uses the earlier chat and the file", /heron/i.test(reply) && /29/.test(reply), `${Math.round((Date.now() - t0) / 1000)}s: ${reply.slice(0, 160)}`);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of chatIds) await fetch(`${BASE}/api/assistant`, json("POST", { action: "delete", chatId: id }));
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
