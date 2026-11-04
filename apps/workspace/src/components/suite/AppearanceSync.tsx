// COPY of web/src/components/iotx/AppearanceSync.tsx (only the import path differs). Keep in step with web; see docs/WORKSPACE-STATUS.md.
"use client";

import { useEffect } from "react";
import type { Appearance } from "@/lib/suite-appearance";
import { applyLocally } from "./appearance-client";

/** Brings this browser in line with the appearance saved to the account (another device may have changed it). */
export default function AppearanceSync({ appearance }: { appearance: Appearance }) {
  useEffect(() => {
    applyLocally(appearance);
  }, [appearance]);
  return null;
}
