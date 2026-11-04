import { requireUser, requireProject } from "@/lib/workspace";
import { listUploads, saveUpload, MAX_UPLOAD_BYTES } from "@/lib/uploads";
import { route } from "@/lib/route";

/** Attach files to a message: multipart form with one or more "file" fields. */
async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");

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
