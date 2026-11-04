import { requireUser, currentWorkspace } from "@/lib/workspace";
import { can, requirePerm } from "@/lib/iotx/permissions";
import {
  checkOfficeRequests,
  connectionOf,
  docGet,
  DOC_REQUESTS,
  driveExport,
  editorFile,
  fileComments,
  GoogleError,
  KINDS,
  officeWrite,
  renameFile,
  slidesGet,
  slideThumb,
  SLIDE_REQUESTS,
  starFile,
  touchViewed,
  unshareImage,
  uploadImage,
} from "@/lib/google";

/**
 * The Docs and Slides editors' API (/api/google/docs/<id>, /api/google/slides/<id>):
 *   GET ?view=open[&touch=1]       -> { file, canEdit, connection, doc | pres }
 *   GET ?view=doc | ?view=pres     -> { doc | pres }           read again (others' edits)
 *   GET ?view=export&format=pdf…   -> the file, exported by Drive (&inline=1 to open it, e.g. to print)
 *   GET ?view=comments             -> { comments }             Drive comments, read only
 *   GET ?view=thumb&page=&size=&v= -> redirect to the slide's picture (Slides only; cached, rate limited)
 *   POST { action: "write", requests, revisionId } -> { replies, revisionId, conflict, doc | pres }
 *   POST { action: "rename", name } | { action: "star", starred }
 *   POST multipart (file)          -> { uri }                  an image put in Drive for inserting
 * Reading needs "<app>.google"; writing needs "<app>.google.edit" and an editing connection.
 */
type OfficeKind = "docs" | "slides";

// The file's type is checked once per person and file for a few minutes, not on every save.
const known = new Map<string, number>();
async function mustBe(kind: OfficeKind, userId: string, id: string) {
  const key = `${kind}:${userId}:${id}`;
  if ((known.get(key) ?? 0) > Date.now()) return;
  const f = await editorFile(userId, id);
  if (f.mimeType !== KINDS[kind].mime) throw new GoogleError(kind === "docs" ? "That file isn't a Google Doc." : "That file isn't a Google Slides presentation.");
  known.set(key, Date.now() + 5 * 60_000);
  if (known.size > 5000) known.clear();
}

// Images uploaded for inserting stay shared by link only until Google has fetched them.
const shared = new Map<string, { userId: string; fileId: string; permissionId: string; timer: ReturnType<typeof setTimeout> }>();
function unshare(uri: string) {
  const s = shared.get(uri);
  if (!s) return;
  shared.delete(uri);
  clearTimeout(s.timer);
  void unshareImage(s.userId, s.fileId, s.permissionId).catch(() => {});
}

// Slide pictures: getThumbnail is an "expensive read" in Google's quota, so
// they're cached per slide version (v, from the editor) and limited per person.
const thumbs = new Map<string, { url: string; exp: number }>();
const buckets = new Map<string, { n: number; at: number }>();
const THUMBS_PER_MIN = 40;
function takeThumb(userId: string) {
  const b = buckets.get(userId) ?? { n: THUMBS_PER_MIN, at: Date.now() };
  b.n = Math.min(THUMBS_PER_MIN, b.n + ((Date.now() - b.at) / 60_000) * THUMBS_PER_MIN);
  b.at = Date.now();
  buckets.set(userId, b);
  if (b.n < 1) return false;
  b.n -= 1;
  return true;
}

const fail = (e: unknown) => {
  if (e instanceof GoogleError) return Response.json({ error: e.message, reconnect: /reconnect|connect it again|isn't connected/i.test(e.message), limited: e.code === 429 }, { status: e.code === 429 ? 429 : 400 });
  throw e;
};

export function officeRoute(kind: OfficeKind) {
  const perm = `${kind}.google`;
  const read = (userId: string, id: string) => (kind === "docs" ? docGet(userId, id) : slidesGet(userId, id));
  const field = kind === "docs" ? "doc" : "pres";

  async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await requireUser();
    const ws = await currentWorkspace(user.id);
    const q = new URL(req.url).searchParams;
    await requirePerm(user.id, ws.id, perm);
    try {
      const view = q.get("view");
      if (view === "open") {
        const connection = await connectionOf(user.id);
        if (!connection) return Response.json({ error: "Google Drive isn't connected.", connect: true }, { status: 400 });
        const file = await editorFile(user.id, id);
        if (file.mimeType !== KINDS[kind].mime) return Response.json({ error: kind === "docs" ? "That file isn't a Google Doc." : "That file isn't a Google Slides presentation." }, { status: 400 });
        const data = await read(user.id, id);
        // Opening it here counts as opening it in Google ("Last opened by me").
        if (q.get("touch") === "1") void touchViewed(user.id, id).catch(() => {});
        const mayEdit = connection.canEdit && (await can(user.id, ws.id, `${perm}.edit`)) && file.capabilities?.canEdit !== false;
        return Response.json({ file, canEdit: mayEdit, connection: { email: connection.email, canEdit: connection.canEdit }, [field]: data });
      }
      if (view === field) return Response.json({ [field]: await read(user.id, id) });
      if (view === "comments") return Response.json({ comments: await fileComments(user.id, id) });
      if (view === "export") {
        await mustBe(kind, user.id, id);
        const format = q.get("format") ?? "pdf";
        if (kind === "docs" ? !["pdf", "docx", "odt", "rtf", "txt", "md", "epub"].includes(format) : !["pdf", "pptx", "odp", "txt"].includes(format)) return Response.json({ error: "Unknown format" }, { status: 400 });
        const f = await driveExport(user.id, id, format);
        const name = (q.get("name") ?? "document").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 120) || "document";
        return new Response(new Uint8Array(f.data), {
          headers: {
            "content-type": f.mime,
            "content-disposition": `${q.get("inline") === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(`${name}.${f.ext}`)}`,
            "cache-control": "private, no-store",
          },
        });
      }
      if (view === "thumb" && kind === "slides") {
        const page = q.get("page") ?? "";
        const size = (["SMALL", "MEDIUM", "LARGE"].includes(q.get("size") ?? "") ? q.get("size") : "MEDIUM") as "SMALL" | "MEDIUM" | "LARGE";
        if (!/^[\w-]{1,100}$/.test(page)) return Response.json({ error: "Bad page" }, { status: 400 });
        const key = `${user.id}:${id}:${page}:${size}:${q.get("v") ?? ""}`;
        let hit = thumbs.get(key);
        if (!hit || hit.exp < Date.now()) {
          if (!takeThumb(user.id)) return Response.json({ error: "Slide pictures are limited by Google; try again shortly.", limited: true }, { status: 429, headers: { "retry-after": "15" } });
          const t = await slideThumb(user.id, id, page, size);
          hit = { url: t.contentUrl, exp: Date.now() + 25 * 60_000 };
          thumbs.set(key, hit);
          if (thumbs.size > 3000) for (const [k, v] of thumbs) if (v.exp < Date.now() || thumbs.size > 2000) thumbs.delete(k);
        }
        return new Response(null, { status: 302, headers: { location: hit.url, "cache-control": "private, max-age=1200" } });
      }
      return Response.json({ error: "Unknown view" }, { status: 400 });
    } catch (e) {
      return fail(e);
    }
  }

  async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await requireUser();
    const ws = await currentWorkspace(user.id);
    await requirePerm(user.id, ws.id, `${perm}.edit`);
    try {
      const connection = await connectionOf(user.id);
      if (!connection) throw new GoogleError("Google Drive isn't connected.");
      if (!connection.canEdit) throw new GoogleError("Editing needs more Google access. Reconnect Google and allow editing.");
      await mustBe(kind, user.id, id);
      if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
        const form = await req.formData();
        const f = form.get("file");
        if (!(f instanceof File)) return Response.json({ error: "No image" }, { status: 400 });
        const up = await uploadImage(user.id, f.name, f.type, Buffer.from(await f.arrayBuffer()));
        unshare(up.uri);
        // If the image never gets inserted, it's made private again anyway.
        shared.set(up.uri, { userId: user.id, fileId: up.fileId, permissionId: up.permissionId, timer: setTimeout(() => unshare(up.uri), 3 * 60_000) });
        return Response.json({ uri: up.uri, fileId: up.fileId });
      }
      const body = (await req.json().catch(() => ({}))) as { action?: string; requests?: unknown; revisionId?: unknown; name?: unknown; starred?: unknown };
      switch (body.action) {
        case "write": {
          const requests = checkOfficeRequests(body.requests, kind === "docs" ? DOC_REQUESTS : SLIDE_REQUESTS);
          const w = await officeWrite(user.id, kind, id, requests, typeof body.revisionId === "string" ? body.revisionId : null);
          for (const r of requests) {
            const uri = ((r.insertInlineImage as { uri?: string } | undefined)?.uri ?? (r.createImage as { url?: string } | undefined)?.url) as string | undefined;
            if (uri && shared.has(uri)) unshare(uri);
          }
          // Read it straight back, so the editor has Google's indexes and the new revision.
          return Response.json({ ...w, [field]: await read(user.id, id) });
        }
        case "rename":
          return Response.json({ file: await renameFile(user.id, id, String(body.name ?? "")) });
        case "star":
          return Response.json({ file: await starFile(user.id, id, !!body.starred) });
        default:
          return Response.json({ error: "Unknown action" }, { status: 400 });
      }
    } catch (e) {
      return fail(e);
    }
  }
  return { GET, POST };
}
