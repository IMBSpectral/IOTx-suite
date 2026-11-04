import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { DRAFT_SCRIPT } from "@/lib/draft-keeper";
import { SUITE_URL } from "@/lib/env";

// Same fonts as the suite (web/src/app/layout.tsx).
const geist = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });

let brandName: { at: number; name: string } | null = null;
async function suiteName() {
  if (brandName && Date.now() - brandName.at < 5 * 60_000) return brandName.name;
  try {
    const r = await fetch(`${SUITE_URL}/api/brand`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    const d = (await r.json()) as { brand?: { name?: string } };
    brandName = { at: Date.now(), name: d.brand?.name || "IOTx Suite" };
  } catch {
    brandName = { at: Date.now(), name: "IOTx Suite" };
  }
  return brandName.name;
}

export async function generateMetadata(): Promise<Metadata> {
  const name = await suiteName();
  return { title: { template: `%s · ${name}`, default: name } };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#4f46e5" };

/**
 * COPY of the suite's before-paint theme script (web/src/app/layout.tsx THEME_SCRIPT): applies the
 * saved theme and accent palette from localStorage. Pages also write the account's appearance
 * there first (lib/page.tsx Frame). Keep in step with web; see docs/WORKSPACE-STATUS.md.
 */
const THEME_SCRIPT = `(function(){try{
var k="forge-theme",d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");
function apply(){var t=localStorage.getItem(k)||"system";d.dataset.theme=t==="system"?(m.matches?"dark":"light"):t;d.style.colorScheme=d.dataset.theme;
var p=null;try{p=JSON.parse(localStorage.getItem("iotx-paint")||"null");}catch(e){}
if(p&&p.palettes){var v=p.palettes[d.dataset.theme]||{};for(var n in v)d.style.setProperty(n,v[n]);}}
apply();m.addEventListener("change",apply);window.addEventListener("storage",function(e){if(e.key===k||e.key==="iotx-paint")apply();});
window.__forgeApplyTheme=apply;
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: DRAFT_SCRIPT }} />
      </head>
      <body className="ix antialiased">{children}</body>
    </html>
  );
}
