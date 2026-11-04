import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { can, requirePerm } from "@/lib/iotx/permissions";
import { checkSheetOps, connectionOf, editorFile, GoogleError, KINDS, renameFile, sheetGrid, sheetLayout, sheetWrite, starFile, touchViewed } from "@/lib/google";
import { forgetSheet } from "@/lib/linked-sheets";

/**
 * The Sheets editor (components/sheets/SheetsEditor) for one spreadsheet.
 *   GET ?view=meta                               -> { file, title, locale, tabs, canEdit, connection }
 *   GET ?view=grid&tab=&r0=&r1=&cols=            -> { r0, rows, rowPx, colPx }   cells with formats
 *   POST { action: "write", ops: [...] }         -> { replies }   values (USER_ENTERED) and batchUpdate requests, in order
 *   POST { action: "rename", name } | { action: "star", starred }
 * Reading needs "sheets.google"; every write needs "sheets.google.edit".
 */

// The file's type is checked once per person and file for a few minutes, not on every save.
const known = new Map<string, number>();
async function mustBeSheet(userId: string, id: string) {
  const key = `${userId}:${id}`;
  if ((known.get(key) ?? 0) > Date.now()) return;
  const f = await editorFile(userId, id);
  if (f.mimeType !== KINDS.sheets.mime) throw new GoogleError("That file isn't a Google Sheet.");
  known.set(key, Date.now() + 5 * 60_000);
  if (known.size > 5000) known.clear();
}

const fail = (e: unknown) => {
  if (e instanceof GoogleError) return Response.json({ error: e.message, reconnect: /reconnect|connect it again|isn't connected/i.test(e.message) }, { status: 400 });
  throw e;
};

async function GET_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  await requirePerm(user.id, ws.id, "sheets.google");
  try {
    if (q.get("view") === "meta") {
      const connection = await connectionOf(user.id);
      if (!connection) return Response.json({ error: "Google Drive isn't connected.", connect: true }, { status: 400 });
      const file = await editorFile(user.id, id);
      if (file.mimeType !== KINDS.sheets.mime) return Response.json({ error: "That file isn't a Google Sheet." }, { status: 400 });
      const layout = await sheetLayout(user.id, id);
      // Opening it here counts as opening it in Google ("Last opened by me").
      if (q.get("touch") === "1") void touchViewed(user.id, id).catch(() => {});
      const mayEdit = connection.canEdit && (await can(user.id, ws.id, "sheets.google.edit")) && file.capabilities?.canEdit !== false;
      return Response.json({ file, ...layout, canEdit: mayEdit, connection: { email: connection.email, canEdit: connection.canEdit } });
    }
    if (q.get("view") === "grid") {
      const r0 = Math.max(0, Math.floor(Number(q.get("r0") ?? 0)));
      const r1 = Math.min(r0 + 1000, Math.max(r0 + 1, Math.floor(Number(q.get("r1") ?? r0 + 200))));
      const cols = Math.max(1, Math.min(18278, Math.floor(Number(q.get("cols") ?? 26))));
      return Response.json(await sheetGrid(user.id, id, q.get("tab") ?? "", r0, r1, cols));
    }
    return Response.json({ error: "Unknown view" }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}

async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as { action?: string; ops?: unknown; name?: unknown; starred?: unknown };
  await requirePerm(user.id, ws.id, "sheets.google.edit");
  try {
    const connection = await connectionOf(user.id);
    if (!connection) throw new GoogleError("Google Drive isn't connected.");
    if (!connection.canEdit) throw new GoogleError("Editing needs more Google access. Reconnect Google and allow editing.");
    await mustBeSheet(user.id, id);
    switch (body.action) {
      case "write": {
        const ops = checkSheetOps(body.ops);
        const replies = await sheetWrite(user.id, id, ops);
        forgetSheet(id);
        return Response.json({ ok: true, replies });
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

export const GET = route(GET_);
export const POST = route(POST_);
