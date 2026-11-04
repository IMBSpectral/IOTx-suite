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
