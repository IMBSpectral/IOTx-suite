"use client";

/**
 * End-to-end encryption keys for Meet. The host's browser makes a random
 * secret; it travels only in the invite link's #k=… fragment (browsers never
 * send fragments to the server) or is typed in like a passcode. LiveKit's
 * ExternalE2EEKeyProvider derives the media key from it (PBKDF2). The server
 * keeps only sha256("iotx-e2ee:" + secret) so a browser can tell a wrong key
 * before joining.
 */

const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (0/o, 1/l/i)
const storeKey = (code: string) => `iotx-meet-e2ee:${code}`;

/** 24 characters from a 31-letter alphabet (~119 bits), grouped for reading out. */
export function newSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  const s = Array.from(b, (x) => ALPHA[x % ALPHA.length]).join("");
  return s.match(/.{6}/g)!.join("-");
}

/** Accept a pasted invite link, a "#k=…" fragment, or the key itself. */
export function parseSecret(input: string) {
  const t = input.trim();
  const m = /[#&]k=([a-z0-9-]+)/i.exec(t);
  const raw = (m ? m[1] : t).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (raw.length !== 24) return null;
  return raw.match(/.{6}/g)!.join("-");
}

export async function checkOf(secret: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`iotx-e2ee:${secret}`));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export const e2eeKeys = {
  get(code: string) {
    try {
      return localStorage.getItem(storeKey(code));
    } catch {
      return null;
    }
  },
  set(code: string, secret: string) {
    try {
      localStorage.setItem(storeKey(code), secret);
    } catch {}
  },
  clear(code: string) {
    try {
      localStorage.removeItem(storeKey(code));
    } catch {}
  },
};

/** The secret from this page's #k=… (then removed from the address bar), if any. */
export function secretFromHash() {
  if (typeof location === "undefined") return null;
  const s = parseSecret(location.hash);
  if (s) history.replaceState(null, "", location.pathname + location.search);
  return s;
}

/** Invite link with the key in the fragment. */
export const linkWithKey = (url: string, secret: string | null) => (secret ? `${url}#k=${secret}` : url);
