"use client";

import { useBrand } from "@/components/BrandProvider";

/** The centre of the orbit: the uploaded logo, or the brand's letters. */
export function OrbitCore() {
  const brand = useBrand();
  if (brand.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brand.logo} alt="" width={56} height={56} style={{ width: 56, height: 56, objectFit: "contain" }} />;
  }
  return <span>{brand.mark}</span>;
}
