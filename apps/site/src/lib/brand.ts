// Shared by server and client: no Node imports here.

/**
 * The platform's brand: every name, mark and line of copy that identifies the
 * product. Set by platform admins in Settings → Branding and read everywhere
 * (pages, emails, the AI's own name), so the suite can be renamed or
 * white-labelled without a code change.
 */
export type Brand = {
  /** Full product name: page titles, sign-in, footers. */
  name: string;
  /** Short name: the AI's name, buttons, tight spaces. */
  shortName: string;
  /** One to three characters shown in the square logo when there's no image. */
  mark: string;
  /** Uploaded logo (served from /api/brand/logo), or null for the text mark. */
  logo: string | null;
  tagline: string;
  /** Legal / company name for the footer. */
  company: string;
  supportEmail: string;
  /** Logo gradient: two colours. */
  colorFrom: string;
  colorTo: string;
};

export const DEFAULT_BRAND: Brand = {
  name: "IOTx Suite",
  shortName: "IOTx",
  mark: "IX",
  logo: null,
  tagline: "Run your entire business from one place.",
  company: "IOTx",
  supportEmail: "",
  colorFrom: "#6d5dfc",
  colorTo: "#a855f7",
};

/**
 * The site's brand: the defaults above, overridable per install with
 * NEXT_PUBLIC_BRAND_* settings (the suite itself keeps its brand in Settings → Branding).
 */
export function siteBrand(): Brand {
  const e = process.env;
  return {
    ...DEFAULT_BRAND,
    ...(e.NEXT_PUBLIC_BRAND_NAME ? { name: e.NEXT_PUBLIC_BRAND_NAME } : {}),
    ...(e.NEXT_PUBLIC_BRAND_SHORT ? { shortName: e.NEXT_PUBLIC_BRAND_SHORT } : {}),
    ...(e.NEXT_PUBLIC_BRAND_MARK ? { mark: e.NEXT_PUBLIC_BRAND_MARK } : {}),
    ...(e.NEXT_PUBLIC_BRAND_COMPANY ? { company: e.NEXT_PUBLIC_BRAND_COMPANY } : {}),
  };
}

/** Where the suite runs: every "Sign in" and legal link goes there. */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://imbspectral.online").replace(/\/$/, "");
