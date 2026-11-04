import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { deleteLogin, listLogins, saveLogin, VaultError } from "@/lib/login-vault";

/** Your saved logins for the agent's cloud browser (never the passwords). */
async function GET_() {
  const user = await requireUser();
  return Response.json({ logins: await listLogins(user.id) });
}

/** save {site, username, password} · delete {id} */
async function POST_(req: Request) {
  const user = await requireUser();
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; site?: string; username?: string; password?: string };
  try {
    if (b.action === "delete") await deleteLogin(user.id, b.id ?? "");
    else await saveLogin(user.id, b);
    return Response.json({ logins: await listLogins(user.id) });
  } catch (e) {
    if (e instanceof VaultError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
