import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import { uploadFile } from "@/lib/files";

/** POST multipart: files (one or more) and parentId (optional) -> { items, errors } */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const form = await req.formData();
  const parentId = typeof form.get("parentId") === "string" && form.get("parentId") ? String(form.get("parentId")) : null;
  const items = [];
  const errors: { name: string; error: string }[] = [];
  for (const f of form.getAll("files")) {
    if (!(f instanceof File)) continue;
    try {
      items.push(await uploadFile(user.id, ws.id, f, parentId));
    } catch (e) {
      if (e instanceof PermissionError) errors.push({ name: f.name, error: e.message });
      else throw e;
    }
  }
  return Response.json({ items, errors }, { status: items.length ? 201 : errors.length ? 400 : 200 });
}

export const POST = route(POST_);
