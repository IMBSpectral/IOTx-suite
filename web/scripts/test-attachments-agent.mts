/**
 * Builder chat attachments reach the AI: one real Ask turn per file type
 * (text, PDF, image) asks what the attached file says; the answer must contain
 * the file's secret word. Spends a few credits; cleans up its messages.
 *   npx tsx scripts/test-attachments-agent.mts <devToken>
 */
import "dotenv/config";
import zlib from "node:zlib";
import { db } from "../src/lib/db";

const [devToken] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const OWNER = `authjs.session-token=${devToken}`;
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2"; // throwaway smoke-test project
let fail = 0;
const check = (l: string, ok: boolean, x: unknown = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${l}${!ok && x ? `  ${JSON.stringify(x).slice(0, 400)}` : ""}`); };

// A one-page PDF with a word in it.
function pdf(word: string) {
  const stream = `BT /F1 24 Tf 72 700 Td (The code word is ${word}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
// A PNG of a solid colour (the question asks for the colour).
function png(r: number, g: number, b: number) {
  const w = 64, h = 64;
  const crc = (buf: Buffer) => { let c = ~0; for (const n of buf) { c ^= n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x2 = 0; x2 < w; x2++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x2 * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function turn(name: string, type: string, data: Buffer, question: string, expect: RegExp) {
  const started = new Date();
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(data)], { type }), name);
  const up = await fetch(`${BASE}/api/projects/${PID}/uploads`, { method: "POST", headers: { cookie: OWNER }, body: fd });
  const uj = (await up.json().catch(() => ({}))) as any;
  const id = uj.attachments?.[0]?.id;
  check(`${name}: upload accepted`, up.ok && !!id, uj);
  const m = await fetch(`${BASE}/api/projects/${PID}/messages`, { method: "POST", headers: { cookie: OWNER, "content-type": "application/json" }, body: JSON.stringify({ content: question, mode: "ask", attachmentIds: [id] }) });
  check(`${name}: message sent with the attachment`, m.status < 300, await m.text().catch(() => ""));
  let build: any = null;
  for (let i = 0; i < 90; i++) {
    build = await db.build.findFirst({ where: { projectId: PID, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
    if (build && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(build.status))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const user = await db.message.findFirst({ where: { projectId: PID, role: "USER", createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
  check(`${name}: the message stores the attachment`, Array.isArray(user?.attachments) && (user!.attachments as any[]).length === 1, user?.attachments);
  const reply = await db.message.findFirst({ where: { projectId: PID, role: "ASSISTANT", createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
  check(`${name}: the AI read it (answer: ${String(reply?.content ?? "").slice(0, 80).replace(/\s+/g, " ")})`, expect.test(reply?.content ?? ""), reply?.content);
  await db.message.deleteMany({ where: { projectId: PID, createdAt: { gte: started } } });
  await db.build.deleteMany({ where: { projectId: PID, createdAt: { gte: started } } });
}

try {
  await turn("notes.txt", "text/plain", Buffer.from("Project notes.\nThe code word is PERIWINKLE42.\n"), "What is the code word in the attached file? Reply with just the word.", /PERIWINKLE42/i);
  await turn("brief.pdf", "application/pdf", pdf("ZANZIBAR77"), "What is the code word in the attached PDF? Reply with just the word.", /ZANZIBAR77/i);
  await turn("swatch.png", "image/png", png(220, 20, 20), "What single colour is the attached image? One word.", /red/i);
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
} finally {
  await db.$disconnect();
}
console.log(`\nAttachments (agent): ${fail ? "FAILED" : "all passed"}`);
process.exit(fail ? 1 : 0);
