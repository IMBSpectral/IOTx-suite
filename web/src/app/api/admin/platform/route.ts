import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { platformSettings, updatePlatformSettings } from "@/lib/platform-settings";
import { freeBuildHour } from "@/lib/credits";

async function requireAdmin() {
  const user = await requireUser();
  if (!isPlatformAdmin(user.email)) throw new Response("Forbidden", { status: 403 });
}

function view() {
  const now = freeBuildHour();
  return { freeBuildHourStart: platformSettings().freeBuildHourStart ?? null, freeBuildHourActiveUntil: now?.endsAt.toISOString() ?? null };
}

async function GET_() {
  await requireAdmin();
  return Response.json(view());
}

/** {freeBuildHourStart: ISO | null}: schedule the free build hour, or turn it off. */
async function POST_(req: Request) {
  await requireAdmin();
  const b = (await req.json().catch(() => ({}))) as { freeBuildHourStart?: string | null };
  if (b.freeBuildHourStart === undefined) return Response.json({ error: "Nothing to change" }, { status: 400 });
  let start: string | null = null;
  if (b.freeBuildHourStart) {
    const d = new Date(b.freeBuildHourStart);
    if (Number.isNaN(d.getTime())) return Response.json({ error: "That time isn't valid." }, { status: 400 });
    start = d.toISOString();
  }
  updatePlatformSettings({ freeBuildHourStart: start });
  return Response.json(view());
}

export const GET = route(GET_);
export const POST = route(POST_);
