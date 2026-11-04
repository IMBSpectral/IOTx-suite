import sanitizeHtml from "sanitize-html";
import { MailError } from "./mailbox";
import { checkRecipient, domainsOf, formatRecipient, htmlToText, parseRecipients, problemText, type Recipient } from "./compose";

/**
 * What the compose window sends, made safe to send: every recipient parsed
 * and checked (a friendly 400 instead of the mail server's "Invalid To
 * header"), and the editor's HTML cleaned down to the tags and styles the
 * editor itself produces, plus what quoted and forwarded mail needs.
 */

// Style values that could fetch or run something are never kept.
const SAFE = [/^(?!.*(?:url\s*\(|expression\s*\(|javascript:|@import|behavio(?:u)?r\s*:)).*$/i];
const STYLES = [
  "color", "background-color", "background", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "text-decoration-line", "text-align",
  "margin", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
  "border", "border-left", "border-right", "border-top", "border-bottom", "border-collapse", "border-color", "border-width", "border-style",
  "line-height", "width", "max-width", "height", "vertical-align", "list-style-type", "white-space", "display",
];

export const OUTGOING: sanitizeHtml.IOptions = {
  allowedTags: ["p", "div", "span", "br", "hr", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "font", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "pre", "code", "img", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "center"],
  allowedAttributes: {
    "*": ["style", "align", "dir"],
    a: ["href", "title", "target", "rel"],
    font: ["color", "face", "size"],
    img: ["src", "alt", "width", "height"],
    td: ["colspan", "rowspan", "width", "height", "valign", "bgcolor"],
    th: ["colspan", "rowspan", "width", "height", "valign", "bgcolor"],
    table: ["width", "cellpadding", "cellspacing", "border", "bgcolor"],
    ol: ["start", "type"],
    div: ["class"],
    blockquote: ["class"],
  },
  allowedClasses: { div: ["gmail_quote", "gmail_attr", "gmail_signature"], blockquote: ["gmail_quote"] },
  allowedStyles: { "*": Object.fromEntries(STYLES.map((s) => [s, SAFE])) },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["https", "cid", "data"] },
  allowProtocolRelative: false,
};

export const cleanOutgoing = (html: string) => sanitizeHtml(html, OUTGOING);

const asList = (v: unknown): string => (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? formatRecipient(x as Recipient) : String(x))).join(", ") : String(v ?? ""));

/**
 * Parse and check To, Cc and Bcc. Throws a MailError naming the first bad
 * address, with a suggestion from the mailbox's own domain or the person's.
 */
export function recipientsFor(body: { to?: unknown; cc?: unknown; bcc?: unknown }, knownAddresses: (string | null | undefined)[] = []) {
  const domains = domainsOf(knownAddresses);
  const field = (v: unknown) => parseRecipients(asList(v)).map((r) => checkRecipient(r, domains));
  const to = field(body.to);
  const cc = field(body.cc);
  const bcc = field(body.bcc);
  const bad = [...to, ...cc, ...bcc].find((r) => !r.ok);
  if (bad) throw new MailError(problemText(bad));
  if (!to.length && !cc.length && !bcc.length) throw new MailError("Add at least one recipient.");
  if (to.length + cc.length + bcc.length > 50) throw new MailError("Send to 50 people or fewer at a time.");
  const fmt = (rs: Recipient[]) => rs.map((r) => formatRecipient({ name: r.name, address: r.address }));
  return { to: fmt(to), cc: fmt(cc), bcc: fmt(bcc) };
}

/** The HTML and plain-text parts. Old clients that send only text still work. */
export function bodyFor(body: { html?: unknown; text?: unknown }) {
  const raw = typeof body.html === "string" ? body.html.slice(0, 2_000_000) : "";
  const html = raw.trim() ? cleanOutgoing(raw) : "";
  const text = html ? htmlToText(html) : String(body.text ?? "");
  return { html: html || undefined, text: text.slice(0, 200_000) };
}
