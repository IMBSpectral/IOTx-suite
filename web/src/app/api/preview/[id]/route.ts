import { verifyPreviewToken } from "@/lib/preview";
import { bundleProject } from "@/lib/preview";

/**
 * Serves the generated app. Authorized by the preview token alone — never by
 * the session cookie — so this response can be moved to its own origin
 * without changing anything here.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 401 });

  try {
    await verifyPreviewToken(token, id);
  } catch {
    return new Response("Invalid token", { status: 403 });
  }

  const { html } = await bundleProject(id);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Generated code is untrusted: deny it the ability to frame-bust,
      // and keep it out of the parent's storage.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-popups allow-modals;",
    },
  });
}
