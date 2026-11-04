"use client";

import { createContext, useContext } from "react";
import { DEFAULT_BRAND, type Brand } from "@/lib/brand-shared";

const BrandContext = createContext<Brand>(DEFAULT_BRAND);

/** Makes the platform brand (Settings → Branding) available to every client component. */
export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);

/** The square logo: the uploaded image, or the text mark on the brand gradient. */
export function BrandMark({ size = 30, className = "", radius }: { size?: number; className?: string; radius?: number }) {
  const b = useBrand();
  const r = radius ?? Math.round(size * 0.3);
  if (b.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={b.logo} alt={b.name} width={size} height={size} className={className} style={{ width: size, height: size, borderRadius: r, objectFit: "contain", flex: "none" }} />;
  }
  return (
    <span
      className={className}
      aria-label={b.name}
      style={{
        width: size,
        height: size,
        borderRadius: r,
        flex: "none",
        display: "inline-grid",
        placeItems: "center",
        color: "#fff",
        fontWeight: 700,
        fontSize: Math.round(size * (b.mark.length > 2 ? 0.32 : 0.4)),
        letterSpacing: "-0.02em",
        background: `linear-gradient(135deg, ${b.colorFrom}, ${b.colorTo})`,
        boxShadow: `0 ${Math.round(size / 5)}px ${Math.round(size / 1.6)}px ${b.colorFrom}55, inset 0 1px 0 rgba(255,255,255,.25)`,
      }}
    >
      {b.mark}
    </span>
  );
}
