import type { MetadataRoute } from "next";
import { getBrand } from "@/lib/brand";

// The brand can change at run time (Settings → Branding), so don't bake it in at build.
export const dynamic = "force-dynamic";

/** Lets browsers install Forge as an app ("Add to home screen" / "Install"). */
export default function manifest(): MetadataRoute.Manifest {
  const brand = getBrand();
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: brand.tagline,
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#0f0f12",
    theme_color: "#6d4aff",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
