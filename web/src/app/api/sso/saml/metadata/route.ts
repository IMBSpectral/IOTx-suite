import { samlMetadata } from "@/lib/sso";

/** Service-provider metadata for SAML identity providers (Okta, Entra ID, Google Workspace…) to import. */
export function GET() {
  return new Response(samlMetadata(), { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" } });
}
