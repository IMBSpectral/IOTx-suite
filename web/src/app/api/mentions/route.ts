import { db } from "@/lib/db";
import { requireUser, currentWorkspace, projectAccess } from "@/lib/workspace";
import { route } from "@/lib/route";
import { visibleTo } from "@/lib/projects";
import { effectiveForRequest } from "@/lib/iotx/permissions";
import { listFiles as repoFiles } from "@/lib/repo";
import { siteOrigin } from "@/lib/site-host";
import { docText, slidesText } from "@/lib/suite-ai";
import * as kb from "@/lib/kb";
import * as g from "@/lib/google";
import * as spaces from "@/lib/spaces";
import { bytesToText, fileRef, refBytes } from "@/lib/ref-files";
import { getAnalysis, listAnalyses } from "@/lib/insights/store";
import { findMail, readMail, type MailHit } from "@/lib/mail/for-ai";

/**
 * The suite's global @ picker, for the apps that live in this server (the
 * Workspace apps answer at /workspace/api/mentions). Only what the person can
 * already open.
 *   GET ?app=builder|spaces|sheets|docs|slides|read|files|gdrive|insights|chat|mail (emails)|people&q=  -> { items }
 *   GET ?ref=/projects/<id> (or /spaces/…, /sheets/…, /docs/…, /slides/…, /knowledge?doc=…, /drive?file=…, /gdrive?file=…, /insights?a=…, /mail?mailbox=…&msg=…, /home/chat?chat=…)
 *                                                                        -> { title, text } for the AI
 */

type Item = { id: string; label: string; sub?: string; url: string; kind: "person" | "item"; email?: string };

async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const s = new URL(req.url).searchParams;
  const e = await effectiveForRequest(user.id, ws.id);
  const has = (key: string) => !e || e.keys.includes(key);
  const opens = (app: string) => !e || e.apps.includes(app);

  const ref = s.get("ref");
  if (ref) {
    const got = await read(ref.slice(0, 500)).catch(() => null);
    return got ? Response.json(got) : Response.json({ error: "Not found" }, { status: 404 });
  }

  const app = s.get("app") ?? "";
  const q = (s.get("q") ?? "").trim().slice(0, 100);
  const like = { contains: q, mode: "insensitive" as const };
  let items: Item[] = [];

  if (app === "builder" && opens("builder")) {
    const rows = await db.project.findMany({
      where: { workspaceId: ws.id, deletedAt: null, ...(await visibleTo(user.id, ws.id)), ...(q ? { name: like } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, name: true, publishedSha: true, updatedAt: true },
    });
    items = rows.map((p) => ({ id: p.id, label: p.name, sub: p.publishedSha ? "Published app" : "Project", url: `/projects/${p.id}`, kind: "item" }));
  } else if (app === "spaces") {
    const { spaces: list } = await spaces.sidebar(await spaces.viewer(user.id, ws.id));
    items = list
      .filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()))
      .map((x) => ({ id: x.id, label: x.name, sub: x.kind === "dashboard" ? "Dashboard" : "Folder", url: `/spaces/${x.id}`, kind: "item" }));
  } else if ((app === "sheets" || app === "docs" || app === "slides") && has(`${app}.google`)) {
    const d = await g.listFiles(user.id, app, q || undefined).catch(() => ({ files: [] as g.DriveFile[] }));
    items = d.files.slice(0, 25).map((f) => ({ id: f.id, label: f.name, sub: `Edited ${f.modifiedTime.slice(0, 10)}`, url: `/${app}/${f.id}`, kind: "item" }));
  } else if (app === "read" && opens("read")) {
    const v = await kb.viewer(user.id, ws.id);
    const docs = await kb.listDocs(v, q ? { text: q } : {}).catch(() => []);
    items = docs
      .filter((d) => d.status === "published")
      .slice(0, 25)
      .map((d) => ({ id: d.id, label: d.title, sub: d.kind, url: `/knowledge?doc=${d.id}`, kind: "item" }));
  } else if (app === "chat" && has("home.ask")) {
    const rows = await db.workspaceChat.findMany({
      where: { userId: user.id, workspaceId: ws.id, ...(q ? { title: like } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, title: true, updatedAt: true },
    });
    items = rows.map((c) => ({ id: c.id, label: c.title, sub: `AI chat · ${c.updatedAt.toISOString().slice(0, 10)}`, url: `/home/chat?chat=${c.id}`, kind: "item" }));
  } else if (app === "files" && opens("files")) {
    // Their own files and files shared with them, most recent first.
    const sharedIds = (await db.fileShare.findMany({ where: { kind: "user", userId: user.id }, select: { fileId: true } })).map((x) => x.fileId);
    const rows = await db.fileItem.findMany({
      where: { workspaceId: ws.id, trashedAt: null, kind: "file", OR: [{ ownerId: user.id }, { id: { in: sharedIds } }], ...(q ? { name: like } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, name: true, size: true, updatedAt: true },
    });
    items = rows.map((f) => ({ id: f.id, label: f.name, sub: `Files · ${f.updatedAt.toISOString().slice(0, 10)}`, url: `/drive?file=${f.id}`, kind: "item" }));
  } else if (app === "gdrive" && opens("gdrive")) {
    const d = await g.driveList(user.id, q ? { search: q } : { view: "recent" }).catch(() => ({ files: [] as g.DriveItem[] }));
    items = d.files
      .filter((f) => f.mimeType !== "application/vnd.google-apps.folder")
      .slice(0, 25)
      .map((f) => ({ id: f.id, label: f.name, sub: `Google Drive · ${f.modifiedTime.slice(0, 10)}`, url: `/gdrive?file=${f.id}`, kind: "item" }));
  } else if (app === "insights" && opens("insights")) {
    const list = await listAnalyses(ws.id, user.id).catch(() => []);
    items = list
      .filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 25)
      .map((a) => ({ id: a.id, label: a.name, sub: `${a.tables.length} tables · ${a.board.length} charts`, url: `/insights?a=${a.id}`, kind: "item" }));
  } else if (app === "mail" && opens("mail")) {
    // Emails: the latest received mail in their mailboxes, searched by sender or subject.
    const r = await findMail(user.id, ws.id, q ? { text: q, limit: 25 } : { limit: 25 }).catch(() => ({ messages: [] as MailHit[] }));
    const byFrom = q ? await findMail(user.id, ws.id, { from: q, limit: 25 }).catch(() => ({ messages: [] as MailHit[] })) : { messages: [] as MailHit[] };
    const seen = new Set<string>();
    items = [...byFrom.messages, ...r.messages]
      .filter((m) => !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 25)
      .map((m) => ({ id: m.id, label: m.subject || "(no subject)", sub: `${m.from} · ${m.date.slice(0, 10)}${m.attachments.length ? ` · ${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}` : ""}`, url: `/mail?mailbox=${m.mailboxId}&msg=${m.id}`, kind: "item" }));
  } else if (app === "people") {
    const rows = await db.membership.findMany({
      where: { workspaceId: ws.id, ...(q ? { user: { OR: [{ name: like }, { email: like }] } } : {}) },
      take: 30,
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    items = rows.map((m) => ({ id: m.user.id, label: m.user.name || m.user.email.split("@")[0], sub: m.user.email, url: `mailto:${m.user.email}`, kind: "person", email: m.user.email }));
  }
  return Response.json({ items });

  /** One referenced item as text, for the AI; null when missing or not theirs to see. */
  async function read(ref: string): Promise<{ title: string; text: string } | null> {
    const u = new URL(ref, "http://x");
    const path = u.pathname;
    let m: RegExpExecArray | null;
    if ((m = /^\/projects\/([\w-]+)/.exec(path)) && opens("builder")) {
      const p = await db.project.findFirst({ where: { id: m[1], workspaceId: ws.id, deletedAt: null } });
      if (!p || !(await projectAccess(user.id, p))) return null;
      const [files, msgs] = await Promise.all([
        repoFiles(p.id).catch(() => [] as string[]),
        db.message.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, take: 6, select: { role: true, content: true } }),
      ]);
      return {
        title: p.name,
        text: `Builder project "${p.name}" (id ${p.id})${p.publishedSha ? `, published at ${siteOrigin(p.subdomain)}` : ", not published"}.\nFiles: ${files
          .filter((f) => !f.startsWith("src/components/ui/"))
          .slice(0, 60)
          .join(", ")}\nRecent chat:\n${msgs
          .reverse()
          .map((x) => `${x.role.toLowerCase()}: ${x.content.slice(0, 500)}`)
          .join("\n")}`,
      };
    }
    if ((m = /^\/spaces\/([\w-]+)/.exec(path))) {
      const sp = await spaces.open(await spaces.viewer(user.id, ws.id), m[1]);
      return { title: sp.name, text: `${sp.kind === "dashboard" ? "Dashboard" : "Folder"} "${sp.name}": ${JSON.stringify({ folders: sp.children.map((c) => c.name), items: sp.items })}` };
    }
    if ((m = /^\/(sheets|docs|slides)\/([\w-]+)/.exec(path)) && has(`${m[1]}.google`)) {
      const id = m[2];
      if (m[1] === "sheets") {
        const [meta, v] = await Promise.all([g.sheetTabs(user.id, id), g.sheetValues(user.id, id)]);
        return { title: meta.title, text: `Google Sheet "${meta.title}" (id ${id}), tabs: ${meta.tabs.join(", ")}\n${v.range}:\n${v.values.map((r) => r.join("\t")).join("\n").slice(0, 30_000)}` };
      }
      if (m[1] === "docs") {
        const d = await g.docGet(user.id, id);
        return { title: d.title, text: `Google Doc "${d.title}" (id ${id}):\n${docText(d).text.replace(/^\[\d+\] /gm, "").slice(0, 30_000)}` };
      }
      const p = await g.slidesGet(user.id, id);
      return { title: p.title ?? "Slides", text: `Google Slides "${p.title ?? ""}" (id ${id}):\n${slidesText(p).slice(0, 30_000)}` };
    }
    if (path.startsWith("/knowledge") && u.searchParams.get("doc") && opens("read")) {
      const d = await kb.getDoc(await kb.viewer(user.id, ws.id), u.searchParams.get("doc")!);
      return { title: d.title, text: `Knowledge article "${d.title}":\n${d.body.slice(0, 30_000)}` };
    }
    // An email in one of their mailboxes: its text, and its attachments (the Builder can take them with read_mail).
    if (path === "/mail" && u.searchParams.get("msg") && opens("mail")) {
      const m = await readMail(user.id, ws.id, u.searchParams.get("msg")!);
      const att = m.attachments.length
        ? `\nAttachments (email id ${m.id}): ${m.attachments.map((a) => `${a.name} (${a.type}, part ${a.part})`).join("; ")}. In the Builder, take one with read_mail action "attach".`
        : "";
      return { title: m.subject || "(no subject)", text: `Email in ${m.mailbox}\nFrom: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body.slice(0, 28_000)}${att}` };
    }
    // A file in Files or in their Google Drive: its text (Word, Excel, PowerPoint and PDF converted).
    const fr = fileRef(path + u.search);
    if (fr && opens(fr.where)) {
      const f = await refBytes(user.id, ws.id, fr);
      const where = fr.where === "files" ? "Files" : "Google Drive";
      return { title: f.name, text: `File "${f.name}" from ${where} (${f.type}, ${Math.round(f.data.length / 1024)} KB):\n${(await bytesToText(f)).slice(0, 30_000)}` };
    }
    if (path.startsWith("/insights") && u.searchParams.get("a") && opens("insights")) {
      const a = await getAnalysis(ws.id, user.id, u.searchParams.get("a")!);
      const tables = a.tables.map((t) => `- ${t.name} (${t.rows.toLocaleString()} rows): ${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")}`).join("\n");
      const board = a.board.map((w) => `- [${w.kind}] ${w.title}${w.insight ? `: ${w.insight}` : ""}`).join("\n");
      return {
        title: a.name,
        text: `Insights analysis "${a.name}" (files: ${a.sources.map((s) => s.name).join(", ") || "none"}).\nTables:\n${tables || "(none)"}\nBoard:\n${board || "(empty)"}\n${a.questions?.length ? `Suggested questions: ${a.questions.join(" | ")}` : ""}`.slice(0, 30_000),
      };
    }
    if (path.startsWith("/home/chat") && u.searchParams.get("chat")) {
      const c = await db.workspaceChat.findFirst({ where: { id: u.searchParams.get("chat")!, userId: user.id, workspaceId: ws.id } });
      if (!c) return null;
      const msgs = await db.workspaceChatMessage.findMany({ where: { chatId: c.id }, orderBy: { createdAt: "asc" }, take: 40 });
      return { title: c.title, text: `Earlier AI chat "${c.title}":\n${msgs.map((x) => `${x.role}: ${x.content}`).join("\n").slice(0, 20_000)}` };
    }
    return null;
  }
}

export const GET = route(GET_);
