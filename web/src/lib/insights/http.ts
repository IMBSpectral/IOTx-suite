import { requireUser, currentWorkspace } from "../workspace";
import { requirePerm } from "../iotx/permissions";
import { route } from "../route";
import { InsightsError, getAnalysis } from "./store";

/** Route wrapper: InsightsError becomes a JSON reply with its status. */
export function insightsRoute<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return route(async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof InsightsError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}

/** The signed-in person in their current workspace, with Insights open and the keys asked for. */
export async function viewer(...keys: string[]) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "insights.open", ...keys);
  return { userId: user.id, workspaceId: ws.id };
}

export async function analysisFor(id: string, ...keys: string[]) {
  const v = await viewer(...keys);
  return { v, a: await getAnalysis(v.workspaceId, v.userId, id) };
}
