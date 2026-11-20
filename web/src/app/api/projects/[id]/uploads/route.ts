import { requireUser, requireProject, currentWorkspace } from "@/lib/workspace";
import { fileRef, refBytes } from "@/lib/ref-files";
import { listUploads, saveUpload, MAX_UPLOAD_BYTES } from "@/lib/uploads";
import { route } from "@/lib/route";

/** Attach files to a message: multipart form with one or more "file" fields. */
async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");

  // Files @-mentioned from Files or Google Drive: copied in as attachments, so the agent gets the
  // file itself (images to use in the app, spreadsheets to read), read as the person who mentioned it.
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as { refs?: unknown };
    const refs = (Array.isArray(b.refs) ? b.refs : []).map((r) => fileRef(String(r))).filter((r): r is NonNullable<ReturnType<typeof fileRef>> => !!r).slice(0, 10);
    const ws = await currentWorkspace(user.id);
    const attachments = [];
    const errors: { ref: string; error: string }[] = [];
    for (const r of refs) {
      try {
        const f = await refBytes(user.id, ws.id, r);
        if (f.data.length > MAX_UPLOAD_BYTES) throw new Error(`${f.name} is larger than 20 MB`);
        attachments.push(await saveUpload(id, { name: f.name, type: f.type, bytes: f.data }));
      } catch (e) {
        errors.push({ ref: `${r.where}:${r.id}`, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return Response.json({ attachments, errors });
  }

  const form = await req.formData().catch(() => null);
  const files = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: "No file" }, { status: 400 });

  const saved = [];
  for (const f of files.slice(0, 10)) {
    if (f.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: `${f.name} is larger than 20 MB` }, { status: 413 });
    }
    saved.push(
      await saveUpload(id, { name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) }),
    );
  }
  return Response.json({ attachments: saved });
}

/** The project's chat attachments, newest first. */
async function GET_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json({ files: await listUploads(id) });
}

export const GET = route(GET_);
export const POST = route(POST_);
