import { route } from "@/lib/route";
import { officeRoute } from "@/lib/google-office";

/** The Docs editor (components/docs/DocsEditor) for one Google Doc; see lib/google-office.ts. */
const r = officeRoute("docs");
export const GET = route(r.GET);
export const POST = route(r.POST);
