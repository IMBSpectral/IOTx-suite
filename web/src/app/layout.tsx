import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { getBrand } from "@/lib/brand";
import { BrandProvider } from "@/components/BrandProvider";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });

// Branding is edited live in Settings → Branding, so pages read it per request.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const b = getBrand();
  return {
    title: b.name,
    description: `${b.name}: ${b.tagline}`,
    appleWebApp: { capable: true, title: b.name, statusBarStyle: "black-translucent" },
    icons: b.logo ? { icon: b.logo } : undefined,
  };
}

export const viewport: Viewport = { themeColor: "#4f46e5" };

/**
 * Applies the saved theme (light, dark or system) and accent palette before
 * the first paint, so pages never flash the wrong colours. "System" follows
 * the OS live. The palette for each theme is computed from the account's
 * accent (lib/iotx/appearance.ts) and mirrored in localStorage.
 */
const THEME_SCRIPT = `(function(){try{
var k="forge-theme",d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");
function apply(){var t=localStorage.getItem(k)||"system";d.dataset.theme=t==="system"?(m.matches?"dark":"light"):t;d.style.colorScheme=d.dataset.theme;
var p=null;try{p=JSON.parse(localStorage.getItem("iotx-paint")||"null");}catch(e){}
if(p&&p.palettes){var v=p.palettes[d.dataset.theme]||{};for(var n in v)d.style.setProperty(n,v[n]);}}
apply();m.addEventListener("change",apply);window.addEventListener("storage",function(e){if(e.key===k||e.key==="iotx-paint")apply();});
window.__forgeApplyTheme=apply;
}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="antialiased">
        <BrandProvider brand={getBrand()}>{children}</BrandProvider>
      </body>
    </html>
  );
}
