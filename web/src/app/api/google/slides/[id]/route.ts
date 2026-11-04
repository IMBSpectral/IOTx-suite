import { route } from "@/lib/route";
import { officeRoute } from "@/lib/google-office";

/** The Slides editor (components/slides/SlidesEditor) for one presentation; see lib/google-office.ts. */
const r = officeRoute("slides");
export const GET = route(r.GET);
export const POST = route(r.POST);
