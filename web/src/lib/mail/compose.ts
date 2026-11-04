/**
 * Composing mail, shared by the browser and the server: parsing what someone
 * typed or pasted into To / Cc / Bcc into recipients, checking each address
 * (with a "did you mean …@company.com?" when the domain has no TLD), and
 * turning the editor's HTML into the plain-text part and back. No
 * dependencies, so the compose window and the send route agree exactly.
 */
export type Recipient = { name: string | null; address: string };
export type Checked = Recipient & { ok: boolean; reason?: string; suggestion?: string };

const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~ -￿-]+$/;
const LABEL = /^(?!-)[A-Za-z0-9 -￿-]{1,63}(?<!-)$/;
const TLD = /^(?:[A-Za-z -￿]{2,63}|xn--[A-Za-z0-9-]{2,59})$/;

/** Split on commas, semicolons and new lines that sit outside quotes and angle brackets. */
function splitList(input: string) {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let angle = false;
  for (const ch of input) {
    if (ch === '"' && !angle) quote = !quote;
    else if (ch === "<" && !quote) angle = true;
    else if (ch === ">" && !quote) angle = false;
    if (!quote && !angle && (ch === "," || ch === ";" || ch === "\n" || ch === "\r")) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const cleanName = (s: string) => s.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/\\(.)/g, "$1").trim() || null;
const cleanAddr = (s: string) => {
  const a = s.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim();
  const at = a.lastIndexOf("@");
  return at > 0 ? `${a.slice(0, at)}@${a.slice(at + 1).toLowerCase()}` : a;
};

/**
 * "a@x.com, B <b@y.com>; \"Shah, Priya\" <p@z.in>" → three recipients.
 * Bare addresses separated only by spaces split too, and "Priya p@z.in"
 * reads as a name and an address. Anything left over stays as typed, so it
 * can be shown (and refused) as an invalid address.
 */
export function parseRecipients(input: string): Recipient[] {
  const out: Recipient[] = [];
  for (const part of splitList(input)) {
    const angle = part.match(/^([\s\S]*?)<([^<>]*)>\s*$/);
    if (angle) {
      out.push({ name: cleanName(angle[1]), address: cleanAddr(angle[2]) });
      continue;
    }
    const words = part.split(/\s+/).filter(Boolean);
    // Words before an address name it; each address ends a recipient.
    const found: Recipient[] = [];
    let name: string[] = [];
    let clean = words.length > 1 && !part.includes('"');
    for (const w of words) {
      if (!clean) break;
      if (!w.includes("@")) name.push(w);
      else if (/^@|@$/.test(w)) clean = false;
      else {
        found.push({ name: name.length ? cleanName(name.join(" ")) : null, address: cleanAddr(w) });
        name = [];
      }
    }
    if (clean && found.length && !name.length) out.push(...found);
    else out.push({ name: null, address: cleanAddr(part) });
  }
  return out;
}

/** The domains worth suggesting, most useful first, without duplicates. */
export function domainsOf(addresses: (string | null | undefined)[]) {
  const seen = new Map<string, number>();
  for (const a of addresses) {
    const d = a?.split("@")[1]?.toLowerCase();
    if (d && d.includes(".")) seen.set(d, (seen.get(d) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

/** A complete domain from the known ones for a domain typed without its TLD ("imbspectral" → "imbspectral.com"). */
function suggestDomain(domain: string, known: string[]) {
  const d = domain.toLowerCase().replace(/\.+$/, "");
  if (!d) return known[0] ?? null;
  return known.find((k) => k.split(".")[0] === d) ?? known.find((k) => k.startsWith(`${d}.`)) ?? known.find((k) => k.startsWith(d)) ?? null;
}

/** Is this a complete, sendable address? If not, why, and what it probably meant. */
export function checkAddress(address: string, knownDomains: string[] = []): { ok: boolean; reason?: string; suggestion?: string } {
  const a = address.trim();
  const bad = (reason: string, suggestion?: string | null) => ({ ok: false, reason, ...(suggestion && suggestion !== a ? { suggestion } : {}) });
  if (!a) return bad("is empty");
  if (/\s/.test(a)) {
    const joined = a.replace(/\s+/g, "");
    return bad("has a space in it", checkAddress(joined, knownDomains).ok ? joined : null);
  }
  const at = a.lastIndexOf("@");
  if (at < 0) return bad("isn't an email address (it has no @)");
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (!local || local.length > 64 || !LOCAL.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return bad("isn't a valid address");
  if (!domain) {
    const s = suggestDomain("", knownDomains);
    return bad("is missing the part after the @", s ? `${local}@${s}` : null);
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !labels[labels.length - 1]) {
    const s = suggestDomain(domain, knownDomains);
    return bad("isn't a complete address", s ? `${local}@${s}` : null);
  }
  if (a.length > 254 || !labels.every((l) => LABEL.test(l))) return bad("isn't a valid address");
  if (!TLD.test(labels[labels.length - 1])) {
    const s = suggestDomain(labels.slice(0, -1).join("."), knownDomains);
    return bad("isn't a complete address", s ? `${local}@${s}` : null);
  }
  return { ok: true };
}

export const checkRecipient = (r: Recipient, knownDomains: string[] = []): Checked => ({ ...r, ...checkAddress(r.address, knownDomains) });

/** The sentence shown for a bad address, in the compose window and from the send route. */
export const problemText = (c: { address: string; reason?: string; suggestion?: string }) =>
  `${c.address || "An address"} ${c.reason ?? "isn't a valid address"}.${c.suggestion ? ` Did you mean ${c.suggestion}?` : ""}`;

/** For headers: "Name" <address>, quoted so commas in names are safe. */
export const formatRecipient = (r: Recipient) => (r.name ? `"${r.name.replace(/["\\\r\n]/g, "")}" <${r.address}>` : r.address);

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text (an AI draft, an old plain-text message) as editor HTML: a div per line, as the editor itself writes. */
export function textToHtml(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.map((l) => (l.trim() ? `<div>${escapeHtml(l)}</div>` : "<div><br></div>")).join("");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "table", "tr", "section", "article", "header", "footer", "hr"]);

/**
 * The plain-text part of a message from its HTML: paragraphs and line breaks
 * kept, list items as "- " or "1. ", links as "text (url)", quoted mail
 * prefixed with "> " like every mail client does.
 */
export function htmlToText(html: string) {
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  const lists: { ordered: boolean; n: number }[] = [];
  let skip = 0;
  let href: string | null = null;
  let linkText = "";
  const prefix = () => "> ".repeat(depth);
  const flush = (force = false) => {
    if (line.trim() || force) lines.push(prefix() + line.replace(/[ \t]+/g, " ").trim());
    line = "";
  };
  const blank = () => {
    flush();
    if (lines.length && lines[lines.length - 1].replace(/>\s?/g, "").trim() !== "") lines.push(prefix().trimEnd());
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      if (skip) continue;
      const t = decode(m[4].replace(/\s+/g, " "));
      if (href !== null) linkText += t;
      line += t;
      continue;
    }
    if (!m[2]) continue;
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "style" || tag === "script" || tag === "head" || tag === "title") {
      skip = Math.max(0, skip + (close ? -1 : 1));
      continue;
    }
    if (skip) continue;
    if (tag === "br") flush(true);
    else if (tag === "blockquote") {
      blank();
      depth = Math.max(0, depth + (close ? -1 : 1));
    } else if (tag === "ul" || tag === "ol") {
      flush();
      if (close) lists.pop();
      else lists.push({ ordered: tag === "ol", n: 0 });
    } else if (tag === "li" && !close) {
      flush();
      const l = lists[lists.length - 1];
      const indent = "  ".repeat(Math.max(0, lists.length - 1));
      line = l?.ordered ? `${indent}${++l.n}. ` : `${indent}- `;
    } else if (tag === "a") {
      if (!close) {
        href = m[3].match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(2).find((x) => x !== undefined) ?? "";
        linkText = "";
      } else {
        const url = decode(href ?? "");
        if (url && !/^mailto:/i.test(url) && url !== linkText.trim()) line += ` (${url})`;
        href = null;
      }
    } else if (tag === "td" || tag === "th") {
      if (close) line += " ";
    } else if (tag === "p" || /^h[1-6]$/.test(tag)) blank();
    else if (BLOCK.has(tag)) flush();
  }
  flush();
  while (lines.length && !lines[lines.length - 1].replace(/>\s?/g, "").trim()) lines.pop();
  while (lines.length && !lines[0].replace(/>\s?/g, "").trim()) lines.shift();
  return lines.join("\n");
}

/** The "On <date>, <name> wrote:" block that replies quote the original in (Gmail's own markup). */
export function quoteBlock(o: { date: string | Date; fromName: string | null; fromAddr: string; html: string | null; text: string | null }) {
  const who = o.fromName ? `${escapeHtml(o.fromName)} &lt;<a href="mailto:${escapeHtml(o.fromAddr)}">${escapeHtml(o.fromAddr)}</a>&gt;` : `<a href="mailto:${escapeHtml(o.fromAddr)}">${escapeHtml(o.fromAddr)}</a>`;
  const body = o.html ?? textToHtml(o.text ?? "");
  return `<div class="gmail_quote"><div class="gmail_attr">On ${escapeHtml(new Date(o.date).toLocaleString())}, ${who} wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${body}</blockquote></div>`;
}

/** Gmail's forwarded-message header and the original underneath. */
export function forwardBlock(o: { date: string | Date; fromName: string | null; fromAddr: string; subject: string; to: Recipient[]; cc?: Recipient[] | null; html: string | null; text: string | null }) {
  const list = (rs: Recipient[]) => rs.map((r) => escapeHtml(r.name ? `${r.name} <${r.address}>` : r.address)).join(", ");
  return `<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: <strong>${escapeHtml(o.fromName ?? "")}</strong> ${escapeHtml(`<${o.fromAddr}>`)}<br>Date: ${escapeHtml(new Date(o.date).toLocaleString())}<br>Subject: ${escapeHtml(o.subject)}<br>To: ${list(o.to ?? [])}<br>${o.cc?.length ? `Cc: ${list(o.cc)}<br>` : ""}</div><br>${o.html ?? textToHtml(o.text ?? "")}</div>`;
}
