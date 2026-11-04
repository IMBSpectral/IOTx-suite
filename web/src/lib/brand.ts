import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";

import { DEFAULT_BRAND, type Brand } from "./brand-shared";

export { DEFAULT_BRAND, type Brand };

const DIR = path.join(PROJECTS_ROOT, "_forge");
const FILE = path.join(DIR, "branding.json");
export const LOGO_FILE = (ext: string) => path.join(DIR, `brand-logo.${ext}`);
export const LOGO_TYPES: Record<string, string> = { png: "image/png", svg: "image/svg+xml", webp: "image/webp", jpg: "image/jpeg" };

const HEX = /^#[0-9a-f]{6}$/i;
const clip = (v: unknown, max: number, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);

function clean(raw: Partial<Brand>): Brand {
  const d = DEFAULT_BRAND;
  return {
    name: clip(raw.name, 40, d.name),
    shortName: clip(raw.shortName, 20, d.shortName),
    mark: clip(raw.mark, 3, d.mark),
    logo: typeof raw.logo === "string" && /^\/api\/brand\/logo\?v=\d+$/.test(raw.logo) ? raw.logo : null,
    tagline: clip(raw.tagline, 120, d.tagline),
    company: clip(raw.company, 60, d.company),
    supportEmail: typeof raw.supportEmail === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.supportEmail.trim()) ? raw.supportEmail.trim() : "",
    colorFrom: typeof raw.colorFrom === "string" && HEX.test(raw.colorFrom) ? raw.colorFrom : d.colorFrom,
    colorTo: typeof raw.colorTo === "string" && HEX.test(raw.colorTo) ? raw.colorTo : d.colorTo,
  };
}

// Read on every request is cheap, but cache by mtime so hot paths don't hit the disk.
let cache: { mtime: number; brand: Brand } | null = null;

/** The current brand (defaults when nothing has been saved). */
export function getBrand(): Brand {
  try {
    const mtime = fs.statSync(FILE).mtimeMs;
    if (cache?.mtime === mtime) return cache.brand;
    const brand = clean(JSON.parse(fs.readFileSync(FILE, "utf8")));
    cache = { mtime, brand };
    return brand;
  } catch {
    return DEFAULT_BRAND;
  }
}

export async function setBrand(patch: Partial<Brand>): Promise<Brand> {
  const next = clean({ ...getBrand(), ...patch });
  await fsp.mkdir(DIR, { recursive: true });
  await fsp.writeFile(FILE, JSON.stringify(next, null, 2));
  cache = null;
  return next;
}

/** Store an uploaded logo and point the brand at it (cache-busted). */
export async function saveLogo(bytes: Buffer, ext: string): Promise<Brand> {
  await fsp.mkdir(DIR, { recursive: true });
  for (const e of Object.keys(LOGO_TYPES)) await fsp.rm(LOGO_FILE(e), { force: true });
  await fsp.writeFile(LOGO_FILE(ext), bytes);
  return setBrand({ logo: `/api/brand/logo?v=${Date.now()}` });
}

export async function removeLogo(): Promise<Brand> {
  for (const e of Object.keys(LOGO_TYPES)) await fsp.rm(LOGO_FILE(e), { force: true });
  return setBrand({ logo: null });
}

/** The logo file on disk, if one was uploaded. */
export async function readLogo(): Promise<{ bytes: Buffer; type: string } | null> {
  for (const [ext, type] of Object.entries(LOGO_TYPES)) {
    try {
      return { bytes: await fsp.readFile(LOGO_FILE(ext)), type };
    } catch {}
  }
  return null;
}
