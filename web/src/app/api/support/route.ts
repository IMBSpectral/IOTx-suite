import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { requireUser, currentWorkspace, projectAccess } from "@/lib/workspace";
import { route } from "@/lib/route";
import { notify } from "@/lib/sharing";
import { sandboxLogs } from "@/lib/sandbox";

const ROOT = path.resolve(process.env.PROJECTS_ROOT ?? path.join(process.cwd(), ".projects"), "_support");
const MAX_FILES = 5;
const MAX_TOTAL = 5 * 1024 * 1024;

/**
 * Contact support. The ticket carries its context (workspace, project,
 * browser) so nobody has to ask for it; up to five JPG/PNG screenshots.
 * Stored on disk locally; a real deployment forwards it to the help desk.
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const form = await req.formData();
  const subject = String(form.get("subject") ?? "").trim().slice(0, 140);
  const message = String(form.get("message") ?? "").trim().slice(0, 5000);
  if (!subject || !message) return Response.json({ error: "Add a subject and a message." }, { status: 400 });

  const projectId = String(form.get("projectId") ?? "") || null;
  if (projectId) {
    const p = await db.project.findUnique({ where: { id: projectId } });
    if (!p || !(await projectAccess(user.id, p))) return Response.json({ error: "Unknown project" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_FILES) return Response.json({ error: "Attach up to 5 images." }, { status: 400 });
  if (files.some((f) => !["image/png", "image/jpeg"].includes(f.type))) {
    return Response.json({ error: "Screenshots must be JPG or PNG." }, { status: 400 });
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) {
    return Response.json({ error: "Attachments can be 5 MB in total." }, { status: 400 });
  }

  const id = `T-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const dir = path.join(ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  const saved: string[] = [];
  for (const [i, f] of files.entries()) {
    const name = `${i + 1}.${f.type === "image/png" ? "png" : "jpg"}`;
    await fs.writeFile(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
    saved.push(name);
  }
  // With the person's consent (Preferences → Sandbox diagnostics), the preview's recent logs go along.
  let diagnostics = false;
  if (projectId) {
    const me = await db.user.findUnique({ where: { id: user.id }, select: { sandboxDiagnostics: true } });
    if (me?.sandboxDiagnostics) {
      const logs = await sandboxLogs(projectId, 200).catch(() => "");
      if (logs) {
        await fs.writeFile(path.join(dir, "sandbox-diagnostics.txt"), logs);
        diagnostics = true;
      }
    }
  }
  await fs.writeFile(
    path.join(dir, "ticket.json"),
    JSON.stringify(
      {
        id,
        at: new Date().toISOString(),
        user: { id: user.id, email: user.email },
        workspace: { id: ws.id, name: ws.name, plan: ws.plan },
        projectId,
        subject,
        message,
        userAgent: req.headers.get("user-agent"),
        files: saved,
        diagnostics,
      },
      null,
      2,
    ),
  );
  await notify([user.id], {
    kind: "support",
    title: `We got your message (${id})`,
    body: subject,
    href: "/help",
  });
  return Response.json({ ok: true, id }, { status: 201 });
}

export const POST = route(POST_);
