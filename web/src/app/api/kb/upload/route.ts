import { createDoc, extractText, KbError } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/**
 * POST multipart: "file" (one or more, up to 10, 20 MB each) and optional
 * kind, tags (comma separated), audience. Each file becomes an article.
 * -> { docs, failed: [{ name, error }] }
 */
async function POST_(req: Request) {
  const v = await kbViewer("read.publish");
  const form = await req.formData().catch(() => null);
  if (!form) throw new KbError("Send the files as a form upload.");
  const files = form.getAll("file").filter((f): f is File => f instanceof File).slice(0, 10);
  if (!files.length) throw new KbError("Choose a file.");
  const kind = String(form.get("kind") ?? "other");
  const tags = String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const audience = String(form.get("audience") ?? "everyone");
  const docs = [];
  const failed: { name: string; error: string }[] = [];
  for (const f of files) {
    try {
      if (f.size > 20 * 1024 * 1024) throw new KbError("Files can be up to 20 MB.");
      const body = await extractText(f.name, f.type, Buffer.from(await f.arrayBuffer()));
      const title = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
      docs.push(await createDoc(v, { title, body, kind, tags, audience, source: "upload", fileName: f.name.slice(0, 200) }));
    } catch (e) {
      if (!(e instanceof KbError)) console.error("kb upload", e);
      failed.push({ name: f.name, error: e instanceof KbError ? e.message : "That file couldn't be read." });
    }
  }
  return Response.json({ docs, failed }, { status: docs.length ? 201 : 400 });
}

export const POST = kbRoute(POST_);
