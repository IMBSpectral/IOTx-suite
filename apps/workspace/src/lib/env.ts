/** Where things live. */
export const BASE = "/workspace";
/** The suite, server to server (verify, google-token). */
export const SUITE_URL = (process.env.SUITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
/** The suite as the browser sees it ("" in production: same origin). */
export const SUITE_PUBLIC_URL = (process.env.SUITE_PUBLIC_URL ?? "").replace(/\/$/, "");
/** This app as the browser sees it ("" in production: same origin as the suite). */
export const WORKSPACE_PUBLIC_URL = (process.env.WORKSPACE_PUBLIC_URL ?? "").replace(/\/$/, "");
export const GOOGLE_API_BASE = (process.env.GOOGLE_API_BASE ?? "https://www.googleapis.com").replace(/\/$/, "");
export const SESSION_COOKIE = "iotx_ws_session";
/** Absolute address for links in emails (RSVP, booking pages): PUBLIC_ORIGIN, else the public URLs above, else the live site. */
export const EMAIL_ORIGIN = (process.env.PUBLIC_ORIGIN || process.env.WORKSPACE_PUBLIC_URL || process.env.SUITE_PUBLIC_URL || "https://imbspectral.online").replace(/\/$/, "");
