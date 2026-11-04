/**
 * Recognises connector credentials pasted into chat, so the composer can
 * offer a secure connector instead of sending the key as a message. Shared by
 * the browser and the server, so it has no server imports.
 */
export const PASTE_PATTERNS: { kind: string; name: string; re: RegExp }[] = [
  { kind: "notion", name: "Notion", re: /\b(ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,})\b/ },
  { kind: "slack", name: "Slack", re: /\bxox[bp]-[A-Za-z0-9-]{20,}\b/ },
  { kind: "stripe", name: "Stripe", re: /\b(sk|rk)_(test|live)_[0-9a-zA-Z]{20,}\b/ },
  { kind: "github", name: "GitHub", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: "openai", name: "OpenAI", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "resend", name: "Resend", re: /\bre_[A-Za-z0-9_]{20,}\b/ },
  { kind: "airtable", name: "Airtable", re: /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/ },
];

export function detectPastedCredential(text: string) {
  for (const p of PASTE_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { kind: p.kind, name: p.name, value: m[0] };
  }
  return null;
}
