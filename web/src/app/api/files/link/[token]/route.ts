import { downloadByLink } from "@/lib/files";

/** A shared file link: opens without signing in until it expires. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return downloadByLink(token);
}
