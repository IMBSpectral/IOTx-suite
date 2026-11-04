import { db } from "@/lib/db";
import { requireUser, currentWorkspace, projectAccess } from "@/lib/workspace";
import { route } from "@/lib/route";
import { can, requirePerm } from "@/lib/iotx/permissions";
import { addTab, appendRow, connectionOf, copyFile, createFile, deleteRow, disconnect, fileMeta, GoogleError, googleConfigured, KINDS, listFiles, renameFile, setCell, sheetTabs, sheetValues, trashFile, type Kind } from "@/lib/google";
import { forgetSheet, linkedSheets, linkSheet, unlinkSheet } from "@/lib/linked-sheets";

/**
 * Google Docs, Sheets and Slides for the signed-in person.
 *   GET ?view=status                      -> { configured, connection }
 *   GET ?view=files&kind=&q=&page=&order=opened|modifiedByMe|modified|name&owner=me|notme -> { files, nextPageToken }
 *   GET ?view=tabs&id=                    -> { title, tabs }
 *   GET ?view=values&id=&range=           -> { range, values }
 *   GET ?view=links&projectId=            -> { links }
 *   GET ?view=projects                    -> { projects }   apps they can link a sheet to
 *   POST { action: "disconnect" }
 *   POST { action: "link" | "unlink", projectId, spreadsheetId }   live data for a built app
 *   POST { action: "create", kind, name } | { action: "rename" | "copy", id, name } | { action: "trash", id }
 *   POST { action: "setCell", id, tab, row, col, value } | "appendRow" (values) | "deleteRow" (row) | "addTab" (name)
 */
const KIND_PERM: Record<Kind, string> = { docs: "docs.google", sheets: "sheets.google", slides: "slides.google" };

async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  try {
    switch (q.get("view")) {
      case "status":
        return Response.json({ configured: googleConfigured(), connection: await connectionOf(user.id) });
      case "files": {
        const kind = (q.get("kind") ?? "sheets") as Kind;
        if (!KINDS[kind]) return Response.json({ error: "Unknown kind" }, { status: 400 });
        await requirePerm(user.id, ws.id, KIND_PERM[kind]);
        const owner = q.get("owner");
        return Response.json(
          await listFiles(user.id, kind, q.get("q") ?? undefined, q.get("page") ?? undefined, { order: q.get("order") ?? undefined, owner: owner === "me" || owner === "notme" ? owner : "" }),
        );
      }
      case "tabs":
        await requirePerm(user.id, ws.id, "sheets.google");
        return Response.json(await sheetTabs(user.id, q.get("id") ?? ""));
      case "values":
        await requirePerm(user.id, ws.id, "sheets.google");
        return Response.json(await sheetValues(user.id, q.get("id") ?? "", q.get("range") ?? undefined));
      case "links": {
        const p = await db.project.findUnique({ where: { id: q.get("projectId") ?? "" } });
        if (!p || !(await projectAccess(user.id, p))) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json({ links: await linkedSheets(p.id) });
      }
      case "projects": {
        const projects = await db.project.findMany({
          where: { workspaceId: ws.id, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 100,
          select: { id: true, name: true, workspaceId: true, restricted: true, folderId: true },
        });
        const editable = [];
        for (const p of projects) {
          const a = await projectAccess(user.id, p);
          if (a && a !== "view") editable.push({ id: p.id, name: p.name });
        }
        return Response.json({ projects: editable });
      }
      default:
        return Response.json({ error: "Unknown view" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof GoogleError) return Response.json({ error: e.message, reconnect: /connect/i.test(e.message) }, { status: 400 });
    throw e;
  }
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> & { action?: string; projectId?: string; spreadsheetId?: string };
  try {
    if (body.action === "disconnect") {
      await disconnect(user.id);
      return Response.json({ ok: true });
    }
    if (body.action === "link" || body.action === "unlink") {
      await requirePerm(user.id, ws.id, "sheets.google.live");
      const p = await db.project.findUnique({ where: { id: body.projectId ?? "" } });
      const access = p ? await projectAccess(user.id, p) : null;
      if (!p || !access || access === "view") return Response.json({ error: "You need edit access to that app." }, { status: 403 });
      const author = { name: user.name ?? user.email ?? "Someone", email: user.email ?? "unknown@localhost" };
      if (body.action === "unlink") {
        await unlinkSheet(p.id, String(body.spreadsheetId), author);
        return Response.json({ ok: true, links: await linkedSheets(p.id) });
      }
      if (!(await can(user.id, ws.id, "sheets.google"))) return Response.json({ error: "Opening Google Sheets isn't turned on for your role." }, { status: 403 });
      const meta = await fileMeta(user.id, String(body.spreadsheetId));
      if (meta.mimeType !== KINDS.sheets.mime) return Response.json({ error: "That file isn't a Google Sheet." }, { status: 400 });
      await linkSheet(p.id, user.id, meta.id, meta.name, author);
      return Response.json({ ok: true, links: await linkedSheets(p.id) });
    }
    // ── Editing (each needs "<app>.google.edit"; the file's real type decides which app) ──
    const kindOfMime = (mime: string) => (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k].mime === mime) ?? null;
    if (body.action === "create") {
      const kind = String(body.kind) as Kind;
      if (!KINDS[kind]) return Response.json({ error: "Unknown kind" }, { status: 400 });
      await requirePerm(user.id, ws.id, `${kind}.google.edit`);
      return Response.json({ file: await createFile(user.id, kind, String(body.name ?? "")) });
    }
    const id = String(body.id ?? body.spreadsheetId ?? "");
    const fileAction = ["rename", "copy", "trash"].includes(String(body.action));
    const sheetAction = ["setCell", "appendRow", "deleteRow", "addTab"].includes(String(body.action));
    if (fileAction || sheetAction) {
      const meta = await fileMeta(user.id, id);
      const kind = kindOfMime(meta.mimeType);
      if (!kind || (sheetAction && kind !== "sheets")) return Response.json({ error: "That file can't be edited here." }, { status: 400 });
      await requirePerm(user.id, ws.id, `${kind}.google.edit`);
      const tab = String(body.tab ?? "");
      switch (body.action) {
        case "rename":
          return Response.json({ file: await renameFile(user.id, id, String(body.name ?? "")) });
        case "copy":
          return Response.json({ file: await copyFile(user.id, id, String(body.name ?? `Copy of ${meta.name}`)) });
        case "trash":
          await trashFile(user.id, id);
          forgetSheet(id);
          return Response.json({ ok: true });
        case "setCell":
          await setCell(user.id, id, tab, Number(body.row), Number(body.col), String(body.value ?? ""));
          break;
        case "appendRow":
          await appendRow(user.id, id, tab, (Array.isArray(body.values) ? body.values : []).map((v) => String(v ?? "")).slice(0, 200));
          break;
        case "deleteRow":
          await deleteRow(user.id, id, tab, Number(body.row));
          break;
        case "addTab":
          await addTab(user.id, id, String(body.name ?? ""));
          break;
      }
      forgetSheet(id);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof GoogleError) return Response.json({ error: e.message, reconnect: /reconnect|connect it again/i.test(e.message) }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
