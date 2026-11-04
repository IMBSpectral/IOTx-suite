/**
 * Rich editing for the chat box, kept as plain text with Markdown so what the
 * agent receives is exactly what the person typed: formatting wraps the
 * selection, mentions and commands are chips drawn behind the text, and a
 * mention is deleted as one piece.
 */

export type Edit = { text: string; start: number; end: number };

/** Wrap the selection in a marker (**, _, `); unwrap if it's already wrapped. With no selection, put the caret between the markers. */
export function wrap(text: string, start: number, end: number, mark: string): Edit {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith(mark) && after.startsWith(mark)) {
    return { text: before.slice(0, -mark.length) + sel + after.slice(mark.length), start: start - mark.length, end: end - mark.length };
  }
  if (sel.length > mark.length * 2 && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(mark.length, -mark.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  // Keep surrounding spaces outside the markers, or Markdown won't format it.
  const lead = sel.match(/^\s*/)![0];
  const trail = sel.slice(lead.length).match(/\s*$/)![0];
  const core = sel.slice(lead.length, sel.length - trail.length);
  const out = `${before}${lead}${mark}${core}${mark}${trail}${after}`;
  const s = start + lead.length + mark.length;
  return { text: out, start: s, end: s + core.length };
}

/** A fenced code block around the selected lines (or an empty one at the caret). */
export function codeBlock(text: string, start: number, end: number): Edit {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const pre = before && !before.endsWith("\n") ? "\n" : "";
  const block = `${pre}\`\`\`\n${sel}\n\`\`\`\n`;
  const s = start + pre.length + 4;
  return { text: before + block + text.slice(end), start: s, end: s + sel.length };
}

/** Turn the selected lines into a list ("- " or "1. "), or back into plain lines when they already are one. */
export function list(text: string, start: number, end: number, kind: "bullet" | "number"): Edit {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end);
  const to = nl === -1 ? text.length : nl;
  const lines = text.slice(from, to).split("\n");
  const re = kind === "bullet" ? /^- / : /^\d+\. /;
  const isList = lines.every((l) => re.test(l) || !l.trim());
  const out = lines.map((l, i) => (isList ? l.replace(re, "") : !l.trim() && lines.length > 1 ? l : `${kind === "bullet" ? "- " : `${i + 1}. `}${l.replace(/^(- |\d+\. )/, "")}`)).join("\n");
  const next = text.slice(0, from) + out + text.slice(to);
  return { text: next, start: from + out.length, end: from + out.length };
}

/** Enter inside a list continues it; Enter on an empty item ends it. Null when the caret isn't in a list item. */
export function continueList(text: string, caret: number): Edit | null {
  const from = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(from, caret);
  const m = /^(\s*)(- |(\d+)\. )(.*)$/.exec(line);
  if (!m) return null;
  if (!m[4].trim()) {
    const t = text.slice(0, from) + text.slice(caret);
    return { text: t, start: from, end: from };
  }
  const marker = m[3] ? `${Number(m[3]) + 1}. ` : "- ";
  const ins = `\n${m[1]}${marker}`;
  return { text: text.slice(0, caret) + ins + text.slice(caret), start: caret + ins.length, end: caret + ins.length };
}

/** Backspace right after a known @mention removes the whole mention. */
export function deleteMention(text: string, caret: number, known: Set<string>): Edit | null {
  const head = text.slice(0, caret);
  // Names with spaces (a picked file or article) first, longest first.
  for (const name of [...known].filter((n) => /[^\w./-]/.test(n)).sort((a, b) => b.length - a.length)) {
    const s = head.length - name.length - 1;
    if (s >= 0 && head.endsWith(`@${name}`) && (s === 0 || /\s/.test(head[s - 1]))) return { text: text.slice(0, s) + text.slice(caret), start: s, end: s };
  }
  const m = /(^|\s)@([\w./-]+)$/.exec(head);
  if (!m || !known.has(m[2])) return null;
  const s = caret - m[2].length - 1;
  return { text: text.slice(0, s) + text.slice(caret), start: s, end: s };
}

/** The known name an "@" at `at` starts, if any: names with spaces (longest first), then a plain word. */
function knownAt(rest: string, at: number, known: Set<string>, spaced: string[]) {
  for (const n of spaced) if (rest.startsWith(n, at + 1) && !/\w/.test(rest[at + 1 + n.length] ?? "")) return n;
  let name = /^[\w./-]+/.exec(rest.slice(at + 1))?.[0] ?? "";
  // A sentence's full stop after a mention isn't part of it.
  while (name && !known.has(name) && /[./-]$/.test(name)) name = name.slice(0, -1);
  return name && known.has(name) ? name : null;
}

/**
 * A picked item's link goes back in on send: each "@Label" the suite picker put in
 * becomes [@Label](link), the form the AI reads the item from. Longest labels first.
 */
export function expandRefs(text: string, links: Record<string, string>) {
  let out = text;
  for (const label of Object.keys(links).sort((a, b) => b.length - a.length)) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|\\s)@${esc}(?!\\w)`, "g"), (_m, pre: string) => `${pre}[@${label}](${links[label]})`);
  }
  return out;
}

export type Segment = { text: string; kind: "text" | "mention" | "command" };

/** Split the text into plain runs, known @mentions and a leading /command, for drawing chips. */
export function segments(text: string, known: Set<string>, commands: Set<string>): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  const cmd = /^\/[\w-]+/.exec(text)?.[0];
  if (cmd && commands.has(cmd)) {
    out.push({ text: cmd, kind: "command" });
    rest = text.slice(cmd.length);
  }
  const spaced = [...known].filter((n) => /[^\w./-]/.test(n)).sort((a, b) => b.length - a.length);
  let last = 0;
  for (let at = rest.indexOf("@"); at >= 0; at = rest.indexOf("@", at + 1)) {
    if (at < last || (at > 0 && !/\s/.test(rest[at - 1]))) continue;
    const name = knownAt(rest, at, known, spaced);
    if (!name) continue;
    if (at > last) out.push({ text: rest.slice(last, at), kind: "text" });
    out.push({ text: `@${name}`, kind: "mention" });
    last = at + name.length + 1;
  }
  if (last < rest.length) out.push({ text: rest.slice(last), kind: "text" });
  return out;
}

/** For showing a sent message: line breaks kept as typed, @mentions become mention: links that render as chips. */
export function linkMentions(md: string) {
  // Not inside code: split out fenced blocks and inline code, and only touch the rest.
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[\s(])@([\w-]+(?:[./][\w-]+)*)/g, (_, pre: string, name: string) => `${pre}[@${name}](mention:${encodeURIComponent(name)})`).replace(/([^\n])\n(?=[^\n])/g, "$1  \n")))
    .join("");
}
