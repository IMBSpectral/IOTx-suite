import type { Metadata } from "next";
import EmbedPage from "@/components/calendar/public/EmbedPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Calendar", robots: { index: false, follow: false } };

/**
 * Public: a calendar someone made available to anyone with the link (or embedded in an iframe).
 * No sign-in and no cookies; ?view=month|week|agenda &title= &notitle=1 &color=RRGGBB &tz=Area/City.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = q.view === "week" || q.view === "agenda" ? q.view : "month";
  return (
    <EmbedPage
      token={/^[A-Za-z0-9_-]{32,64}$/.test(token) ? token : ""}
      view={view}
      title={q.title ? q.title.slice(0, 120) : null}
      color={q.color && /^[0-9a-f]{6}$/i.test(q.color) ? q.color : null}
      tz={q.tz ? q.tz.slice(0, 64) : null}
      noTitle={q.notitle === "1"}
    />
  );
}
