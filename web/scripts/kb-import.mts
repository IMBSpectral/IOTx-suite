/**
 * Imports a knowledge-base folder. With --platform it becomes the project's own
 * (platform) knowledge: every AI in the suite reads it, no workspace's Knowledge
 * app shows it (see PLATFORM in src/lib/kb.ts). Without it, the folder goes into one
 * workspace's company knowledge base ("Knowledge" app).
 *
 *   npx tsx scripts/kb-import.mts <folder> --platform [--include-restricted] [--replace <name>=<file>] [--dry]
 *   npx tsx scripts/kb-import.mts <folder> [--ws <workspaceId>] [--user <userId>] [--session <devToken>]
 *                                 [--include-restricted] [--replace <name>=<file>] [--dry]
 *
 * Layout it understands (see the folder's README):
 *   company/              the company's own documents → everyone in the workspace who isn't a guest ("members")
 *   identity/             agent persona and memory   → admins only, tag "identity"
 *   reference-open/       freely redistributable books → members, tag "reference"
 *   reference-restricted/ copyrighted books → skipped unless --include-restricted (then admins only, tag "restricted")
 * Anything else is imported as members-only "other".
 *
 * PDFs keep their pages ("## Page N", so answers can cite pages) and long
 * files become several articles of up to ~60,000 characters each, split at
 * page breaks. Re-running is safe: each article remembers its file and part
 * (externalId "folder:<path>#<part>") and the file's sha256, so unchanged files
 * are skipped and changed ones are updated in place (a new version).
 * --replace swaps in a converted copy, e.g. --replace vahn-persistent-memory.doc=C:\x\memory.docx
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { createDoc, extractText, PLATFORM, putPlatformDoc, updateDoc, viewer, type Viewer } from "../src/lib/kb";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.match(/^--(ws|user|session|replace)$/));
const opt = (k: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : undefined);
const dry = args.includes("--dry");
const restricted = args.includes("--include-restricted");
const replace = new Map(args.flatMap((a, i) => (args[i - 1] === "--replace" ? [a.split("=") as [string, string]] : [])));
if (!folder || !fs.existsSync(folder)) {
  console.error("usage: npx tsx scripts/kb-import.mts <folder> [--ws id] [--user id | --session devToken] [--include-restricted] [--replace name=file] [--dry]");
  process.exit(2);
}

const platform = args.includes("--platform");
// Who imports into a workspace (an owner or admin: they need read.publish). The platform needs no one.
let ws = PLATFORM;
let v: Viewer | null = null;
if (!platform) {
  let userId = opt("user");
  if (!userId && opt("session")) userId = (await db.session.findUnique({ where: { sessionToken: opt("session")! } }))?.userId;
  if (!userId) throw new Error("Pass --platform, or --user <userId> / --session <devToken>.");
  const w = opt("ws") ?? (await db.membership.findFirst({ where: { userId, role: "OWNER" }, orderBy: { createdAt: "asc" } }))?.workspaceId;
  if (!w) throw new Error("No workspace: pass --ws.");
  ws = w;
  v = await viewer(userId, ws);
}

const PART = 60_000;
type Plan = { rel: string; audience: string; tags: string[]; kind: string; skip?: string };
function plan(rel: string): Plan {
  const top = rel.split(/[\\/]/)[0];
  const base = path.basename(rel).toLowerCase();
  if (base === "readme.md") return { rel, audience: "admins", tags: [], kind: "other", skip: "the folder's own notes" };
  if (top === "company") return { rel, audience: "members", tags: ["company", "imb"], kind: /architecture|spec/.test(base) ? "product" : "other" };
  if (top === "identity") return { rel, audience: "admins", tags: ["identity", "vahn"], kind: "other" };
  if (top === "reference-open") return { rel, audience: "members", tags: ["reference"], kind: "other" };
  if (top === "reference-restricted") return restricted ? { rel, audience: "admins", tags: ["reference", "restricted"], kind: "other" } : { rel, audience: "admins", tags: [], kind: "other", skip: "copyrighted (use --include-restricted)" };
  return { rel, audience: "members", tags: [], kind: "other" };
}

const titleOf = (rel: string) => {
  const n = path.basename(rel).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\bv(\d)/i, "v$1");
  const t = (n.charAt(0).toUpperCase() + n.slice(1)).replace(/\b(imb|vahn|bmc|uvp|mvp)\b/gi, (w) => w.toUpperCase());
  return t === "Art of war sun tzu" ? "The Art of War (Sun Tzu)" : t;
};

async function pages(buf: Buffer) {
  const { extractText: pdf, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await pdf(doc, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t) => t.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\u0000/g, "").trim());
}

/** The file as one or more { label, body } parts. */
async function parts(file: string, rel: string): Promise<{ label: string; body: string }[]> {
  const buf = fs.readFileSync(file);
  if (file.toLowerCase().endsWith(".pdf")) {
    const ps = await pages(buf);
    const out: { label: string; body: string }[] = [];
    let cur: string[] = [];
    let from = 1, size = 0;
    ps.forEach((t, i) => {
      if (!t) return;
      const block = `## Page ${i + 1}\n\n${t}`;
      if (size + block.length > PART && cur.length) {
        out.push({ label: `pages ${from}–${i}`, body: cur.join("\n\n") });
        cur = [];
        size = 0;
        from = i + 1;
      }
      cur.push(block);
      size += block.length;
    });
    if (cur.length) {
      // A short last stretch joins the part before it.
      const last = out[out.length - 1];
      if (last && size < PART / 6) out[out.length - 1] = { label: `${last.label.split("–")[0]}–${ps.length}`, body: `${last.body}\n\n${cur.join("\n\n")}` };
      else out.push({ label: `pages ${from}–${ps.length}`, body: cur.join("\n\n") });
    }
    return out.map((x) => {
      const m = /^pages (\d+)–(\d+)$/.exec(x.label);
      return m && m[1] === m[2] ? { ...x, label: `page ${m[1]}` } : x;
    });
  }
  const body = await extractText(path.basename(file), "", buf);
  if (body.length <= PART) return [{ label: "", body }];
  const out: { label: string; body: string }[] = [];
  let cur = "";
  for (const p of body.split(/\n{2,}/)) {
    if (cur && cur.length + p.length > PART) {
      out.push({ label: "", body: cur });
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push({ label: "", body: cur });
  return out.map((x, i) => ({ ...x, label: `part ${i + 1} of ${out.length}` }));
  void rel;
}

const files: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(folder);

let made = 0, updated = 0, same = 0, skipped = 0;
for (const f of files.sort()) {
  const rel = path.relative(folder, f).replace(/\\/g, "/");
  const p = plan(rel);
  if (p.skip) {
    console.log(`skip   ${rel} — ${p.skip}`);
    skipped++;
    continue;
  }
  const real = replace.get(path.basename(f)) ?? f;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex");
  let ps: { label: string; body: string }[];
  try {
    ps = await parts(real, rel);
  } catch (e) {
    console.log(`FAILED ${rel} — ${(e as Error).message}`);
    skipped++;
    continue;
  }
  const base = titleOf(rel);
  for (const [i, part] of ps.entries()) {
    const externalId = `folder:${rel}#${i + 1}`;
    const title = ps.length > 1 ? `${base} — ${part.label}${part.label.startsWith("pages") ? ` (${i + 1} of ${ps.length})` : ""}` : base;
    const body = `> From the ${platform ? "project's" : "company"} knowledge base: \`${rel}\`${part.label ? `, ${part.label}` : ""}.\n\n${part.body}`;
    const had = await db.kbDoc.findFirst({ where: { workspaceId: ws, externalId } });
    if (had && had.externalModified === hash) {
      same++;
      continue;
    }
    console.log(`${had ? "update" : "add   "} ${title}  (${body.length.toLocaleString()} chars, ${p.audience}${p.tags.length ? `, #${p.tags.join(" #")}` : ""})`);
    if (dry) continue;
    if (platform) {
      const r = await putPlatformDoc(externalId, { title, body, kind: p.kind, tags: p.tags, audience: p.audience, fileName: path.basename(rel), hash });
      if (r === "added") made++;
      else if (r === "updated") updated++;
      continue;
    }
    if (had) {
      await updateDoc(v!, had.id, { title, body, kind: p.kind, tags: p.tags, audience: p.audience, note: "Re-imported: the file changed" });
      await db.kbDoc.update({ where: { id: had.id }, data: { externalModified: hash } });
      updated++;
    } else {
      const d = await createDoc(v!, { title, body, kind: p.kind, tags: p.tags, audience: p.audience, source: "upload", fileName: path.basename(rel) });
      await db.kbDoc.update({ where: { id: d.id }, data: { externalId, externalModified: hash } });
      made++;
    }
  }
  // A file that now has fewer parts: archive the leftovers.
  if (!dry) await db.kbDoc.updateMany({ where: { workspaceId: ws, externalId: { startsWith: `folder:${rel}#` }, NOT: { externalId: { in: ps.map((_, i) => `folder:${rel}#${i + 1}`) } } }, data: { status: "archived" } });
}
console.log(`\n${dry ? "Dry run: " : ""}${made} added, ${updated} updated, ${same} unchanged, ${skipped} skipped · workspace ${ws}`);
await db.$disconnect();
