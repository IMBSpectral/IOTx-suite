import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { dropShell, suiteCall } from "@/lib/suite";
import { SUITE_PUBLIC_URL } from "@/lib/env";
import type { Appearance } from "@/lib/suite-appearance";

/** POST Partial<Appearance> -> the shell's theme menu, saved to the suite account. */
async function POST_(req: Request) {
  const me = await requireMe();
  const patch = await body(req);
  const r = await suiteCall<{ appearance?: Appearance; error?: string }>("/api/iotx/shell", { body: { userId: me.userId, appearance: patch } });
  if (r.status !== 200 || !r.data.appearance) return Response.json({ error: r.data.error ?? "Couldn't save." }, { status: r.status === 200 ? 502 : r.status });
  dropShell(me.userId);
  const a = r.data.appearance;
  if (a.shellBg?.kind === "image" && a.shellBg.image?.startsWith("/")) a.shellBg = { ...a.shellBg, image: `${SUITE_PUBLIC_URL}${a.shellBg.image}` };
  return Response.json({ appearance: a });
}

export const POST = route(POST_);
