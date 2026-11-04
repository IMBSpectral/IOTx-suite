import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { EnvError, readEnvNames, updateEnv } from "@/lib/env-vars";

type Ctx = { params: Promise<{ id: string }> };

/** Names of the project's environment variables (values never leave the server). */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.code.edit");
  return Response.json({ names: await readEnvNames(id) });
}

async function PUT_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.code.edit");
  const body = (await req.json().catch(() => ({}))) as { set?: unknown; remove?: unknown };
  try {
    return Response.json({ names: await updateEnv(id, body.set, body.remove) });
  } catch (e) {
    if (e instanceof EnvError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const PUT = route(PUT_);
