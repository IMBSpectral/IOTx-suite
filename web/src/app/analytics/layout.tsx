import { notFound } from "next/navigation";
import { SERVER_OFF } from "@/lib/iotx/permissions";

/** Standalone Insights (/analytics, /analytics/login) doesn't exist on a server that switches Insights off. */
export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  if (SERVER_OFF.has("insights")) notFound();
  return children;
}
