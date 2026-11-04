import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { deleteSkill, listSkills, personalOwner, saveSkill, SkillError } from "@/lib/skills";

/** Skills (reusable workflows for the agent): the workspace's, and the user's personal ones. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  return Response.json({ skills: await listSkills(ws.id), personal: await listSkills(personalOwner(user.id)) });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as {
    action?: "save" | "delete";
    scope?: "workspace" | "personal";
    id?: string;
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
  };
  const owner = body.scope === "personal" ? personalOwner(user.id) : ws.id;
  try {
    if (body.action === "delete") {
      await deleteSkill(owner, body.id ?? "");
      return Response.json({ ok: true });
    }
    return Response.json({ skill: await saveSkill(owner, user.id, body) });
  } catch (e) {
    if (e instanceof SkillError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
