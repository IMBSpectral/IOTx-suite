import { INSPECTOR_SCRIPT } from "@/lib/inspector";
import { MONITOR_SCRIPT } from "@/lib/preview-monitor";

/**
 * Served to project dev servers so click-to-select and runtime monitoring work
 * inside a container preview. It is injected by a dev-only Vite plugin, never
 * bundled into a published build, and never written into the project's own
 * source. The monitor goes first so it is listening before the app boots.
 */
export async function GET() {
  return new Response(MONITOR_SCRIPT + "\n" + INSPECTOR_SCRIPT, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
