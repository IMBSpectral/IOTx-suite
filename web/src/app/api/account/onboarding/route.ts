import fs from "node:fs/promises";
import path from "node:path";
import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PROJECTS_ROOT } from "@/lib/paths";
import { ROLES, startersFor } from "@/lib/onboarding";

const file = (userId: string) => path.join(PROJECTS_ROOT, "_forge", "onboarding", `${userId.replace(/[^\w-]/g, "")}.json`);

/** The person's onboarding answers (role, weekly tasks), or null when not done. */
async function GET_() {
  const user = await requireUser();
  const raw = await fs.readFile(file(user.id), "utf8").catch(() => null);
  return Response.json({ answers: raw ? JSON.parse(raw) : null });
}

/** {role, tasks} → saved; returns the starter apps for the workspace preview. {skip: true} hides it. */
async function POST_(req: Request) {
  const user = await requireUser();
  const b = (await req.json().catch(() => ({}))) as { role?: string; tasks?: string[]; skip?: boolean };
  const save = async (v: unknown) => {
    await fs.mkdir(path.dirname(file(user.id)), { recursive: true });
    await fs.writeFile(file(user.id), JSON.stringify(v));
  };
  if (b.skip) {
    await save({ skipped: true, at: new Date().toISOString() });
    return Response.json({ ok: true });
  }
  if (!b.role || !ROLES[b.role]) return Response.json({ error: "Pick a role." }, { status: 400 });
  const tasks = (Array.isArray(b.tasks) ? b.tasks : []).filter((t) => ROLES[b.role!].some((s) => s.task === t)).slice(0, 5);
  if (!tasks.length) return Response.json({ error: "Pick at least one task." }, { status: 400 });
  await save({ role: b.role, tasks, at: new Date().toISOString() });
  return Response.json({ starters: startersFor(b.role, tasks) });
}

export const GET = route(GET_);
export const POST = route(POST_);
