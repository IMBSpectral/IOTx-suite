import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { readVisual, visualPage } from "@/lib/visuals";

type Ctx = { params: Promise<{ id: string; visualId: string }> };

/** A visual explanation, served sandboxed: scripts may draw, but nothing loads from the network. */
async function GET_(req: Request, { params }: Ctx) {
  const { id, visualId } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  const found = await readVisual(id, visualId);
  if (!found) return Response.json({ error: "Not found" }, { status: 404 });
  const theme = new URL(req.url).searchParams.get("theme") === "dark" ? "dark" : "light";
  return new Response(visualPage(found.visual, found.body, theme), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    },
  });
}

export const GET = route(GET_);
