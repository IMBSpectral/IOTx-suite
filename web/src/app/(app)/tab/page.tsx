import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * /tab?u=<path>: opens a page in a suite tab. Workspace pages opened on their
 * own (a bookmark, a shared link, a refresh) come here, and the browser frame
 * (the layout) opens them as a tab. Only a request from inside a tab goes on to
 * the page itself; the top window must stay here, or it would loop.
 */
export default async function TabPage({ searchParams }: { searchParams: Promise<{ u?: string }> }) {
  if ((await headers()).get("sec-fetch-dest") !== "iframe") return null;
  const { u } = await searchParams;
  redirect(u && u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\") ? u : "/home");
}
