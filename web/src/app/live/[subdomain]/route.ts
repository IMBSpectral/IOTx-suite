import { siteUrl } from "@/lib/publish";

/** Old path-based address for a published app; it now lives on its own host. */
export async function GET(_req: Request, { params }: { params: Promise<{ subdomain: string }> }) {
  const { subdomain } = await params;
  return Response.redirect(siteUrl(subdomain), 301);
}
