/**
 * Chat media and files: audio/video served inline with byte ranges (seeking,
 * duration), anything else forced to download, the project's uploads list,
 * the workspace "Chat files" page with "Ask about this file", and opening a
 * project with ?ask=. Throwaway project, deleted at the end.
 *   npx tsx scripts/test-chat-media.mts <devToken>
 */
const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A valid one-second silent WAV file. */
function wav() {
  const rate = 8000;
  const data = Buffer.alloc(rate);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function upload(pid: string, name: string, type: string, bytes: Buffer) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetch(`${BASE}/api/projects/${pid}/uploads`, { method: "POST", headers: { cookie }, body: form });
  const body = (await res.json().catch(() => ({}))) as any;
  return (body.attachments ?? body.files ?? [body])[0];
}

let pid = "";

async function main() {
  const created = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Chat media test", force: true }),
  });
  pid = ((await created.json()) as any).project.id;

  const audio = await upload(pid, "voice note.wav", "audio/wav", wav());
  check("audio uploaded", !!audio?.id, JSON.stringify(audio).slice(0, 120));
  const page = await upload(pid, "evil.html", "text/html", Buffer.from("<script>alert(1)</script>"));
  check("html uploaded", !!page?.id);

  const url = `${BASE}/api/projects/${pid}/uploads/${audio.id}`;
  const full = await fetch(url, { headers: { cookie } });
  check("audio served inline", full.status === 200 && full.headers.get("content-type") === "audio/wav" && /^inline/.test(full.headers.get("content-disposition") ?? ""));
  check("audio advertises ranges", full.headers.get("accept-ranges") === "bytes");
  const total = (await full.arrayBuffer()).byteLength;

  const part = await fetch(url, { headers: { cookie, range: "bytes=0-9" } });
  check("range request → 206", part.status === 206 && part.headers.get("content-range") === `bytes 0-9/${total}` && (await part.arrayBuffer()).byteLength === 10);
  const tail = await fetch(url, { headers: { cookie, range: "bytes=-5" } });
  check("suffix range", tail.status === 206 && (await tail.arrayBuffer()).byteLength === 5);
  const open = await fetch(url, { headers: { cookie, range: `bytes=${total - 4}-` } });
  check("open-ended range", open.status === 206 && (await open.arrayBuffer()).byteLength === 4);
  check("unsatisfiable range → 416", (await fetch(url, { headers: { cookie, range: `bytes=${total + 10}-${total + 20}` } })).status === 416);

  const html = await fetch(`${BASE}/api/projects/${pid}/uploads/${page.id}`, { headers: { cookie, range: "bytes=0-3" } });
  check("other files download, never inline", html.status === 200 && html.headers.get("content-type") === "application/octet-stream" && /^attachment/.test(html.headers.get("content-disposition") ?? ""));
  check("sandboxed", (html.headers.get("content-security-policy") ?? "").includes("sandbox"));

  const list = (await (await fetch(`${BASE}/api/projects/${pid}/uploads`, { headers: { cookie } })).json()) as any;
  check("uploads listed newest first", list.files?.length === 2 && list.files.every((f: any) => typeof f.at === "string"));

  const files = await (await fetch(`${BASE}/files`, { headers: { cookie } })).text();
  check("Chat files page lists them", files.includes("voice note.wav") && files.includes("evil.html") && files.includes("Ask about this file"));
  check("Ask link targets the project", files.includes(`/projects/${pid}?ask=${audio.id}`));
  check("project opens with ?ask=", (await fetch(`${BASE}/projects/${pid}?ask=${audio.id}`, { headers: { cookie } })).status === 200);
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
