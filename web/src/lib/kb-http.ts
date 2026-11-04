import { requireUser, currentWorkspace } from "./workspace";
import { requirePerm } from "./iotx/permissions";
import { route } from "./route";
import { KbError, viewer } from "./kb";

/** Route wrapper for the knowledge base: KbError becomes a JSON reply with its status. */
export function kbRoute<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return route(async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof KbError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}

/** The signed-in person in their current workspace, with the Read app on and the keys asked for. */
export async function kbViewer(...keys: string[]) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "read.view", ...keys);
  return viewer(user.id, ws.id);
}
