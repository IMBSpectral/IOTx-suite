"use client";
import { Fragment, useMemo, type ReactNode } from "react";
import { emojiFor } from "./emoji";
import type { Group, Person } from "./types";

/**
 * Message formatting, rendered as React elements (never raw HTML):
 * *bold* / **bold**, _italic_, ~strike~, `code`, ```code blocks```,
 * > quotes, - bulleted and 1. numbered lists, links ([text](url) too),
 * :emoji: shortcodes, @mentions, @channel / @here and @group handles.
 */
type Ctx = { people: Person[]; groups: Group[]; meId: string; channels?: string[]; onChannel?: (name: string) => void };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function inlineRules(ctx: Ctx) {
  const handles = [
    ...ctx.people.flatMap((p) => [p.name, p.email.split("@")[0]]).filter(Boolean),
    ...ctx.groups.map((g) => g.handle),
    "channel", "here", "everyone",
  ].sort((a, b) => b.length - a.length).map(esc);
  return [
    { k: "code", re: /`([^`\n]+)`/g },
    { k: "mdlink", re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g },
    { k: "url", re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g },
    { k: "mention", re: new RegExp(`@(${handles.join("|")})(?![\\w-])`, "gi") },
    { k: "chan", re: /(?<![\w/#])#([a-z0-9_-]{2,60})\b/g },
    { k: "bold", re: /\*\*(?!\s)([^*\n]+?)\*\*|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g },
    { k: "italic", re: /(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g },
    { k: "strike", re: /(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])/g },
    { k: "emoji", re: /:([a-z0-9_+-]{1,40}):/g },
  ];
}

function inline(text: string, ctx: Ctx, rules: ReturnType<typeof inlineRules>, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let n = 0;
  while (pos < text.length) {
    let best: { k: string; m: RegExpExecArray } | null = null;
    for (const r of rules) {
      r.re.lastIndex = pos;
      const m = r.re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { k: r.k, m };
    }
    if (!best) break;
    const { k, m } = best;
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const id = `${key}-${n++}`;
    const inner = (s: string) => inline(s, ctx, rules, id);
    let el: ReactNode = m[0];
    switch (k) {
      case "code": el = <code key={id} className="ch-code">{m[1]}</code>; break;
      case "mdlink": el = <a key={id} href={m[2]} target="_blank" rel="noreferrer noopener">{m[1]}</a>; break;
      case "url": el = <a key={id} href={m[0]} target="_blank" rel="noreferrer noopener">{m[0]}</a>; break;
      case "mention": {
        const h = m[1].toLowerCase();
        const who = ctx.people.find((p) => p.name.toLowerCase() === h || p.email.split("@")[0].toLowerCase() === h);
        const grp = ctx.groups.find((g) => g.handle === h);
        if (["channel", "here", "everyone"].includes(h)) el = <span key={id} className="ch-mention all">@{h}</span>;
        else if (who) el = <span key={id} className={`ch-mention${who.id === ctx.meId ? " me" : ""}`} title={who.email}>@{who.name}</span>;
        else if (grp) el = <span key={id} className={`ch-mention${grp.memberIds.includes(ctx.meId) ? " me" : ""}`} title={grp.name}>@{grp.handle}</span>;
        break;
      }
      case "chan":
        el = ctx.onChannel && ctx.channels?.includes(m[1]) ? <button key={id} type="button" className="ch-chanlink" onClick={() => ctx.onChannel!(m[1])}>#{m[1]}</button> : m[0];
        break;
      case "bold": el = <b key={id}>{inner(m[1] ?? m[2])}</b>; break;
      case "italic": el = <i key={id}>{inner(m[1])}</i>; break;
      case "strike": el = <s key={id}>{inner(m[1])}</s>; break;
      case "emoji": el = emojiFor(m[1]) ? <span key={id} className="ch-emoji" title={`:${m[1]}:`}>{emojiFor(m[1])}</span> : m[0]; break;
    }
    out.push(el);
    pos = m.index + Math.max(1, m[0].length);
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export default function Rich({ text, people, groups = [], meId, channels, onChannel, big }: { text: string; people: Person[]; groups?: Group[]; meId: string; channels?: string[]; onChannel?: (name: string) => void; big?: boolean }) {
  const ctx = useMemo(() => ({ people, groups, meId, channels, onChannel }), [people, groups, meId, channels, onChannel]);
  const rules = useMemo(() => inlineRules(ctx), [ctx]);
  const blocks = useMemo(() => {
    const out: ReactNode[] = [];
    const lines = text.split("\n");
    let i = 0;
    let n = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trimStart().startsWith("```")) {
        // Code block, to the closing fence (or the end).
        const first = l.trimStart().slice(3);
        const body: string[] = first && !first.endsWith("```") ? [first] : [];
        if (first.endsWith("```") && first.length > 3) {
          out.push(<pre key={n++} className="ch-pre"><code>{first.slice(0, -3)}</code></pre>);
          i++;
          continue;
        }
        i++;
        while (i < lines.length && !lines[i].trimEnd().endsWith("```")) body.push(lines[i++]);
        if (i < lines.length) {
          const last = lines[i].trimEnd().slice(0, -3);
          if (last) body.push(last);
          i++;
        }
        out.push(<pre key={n++} className="ch-pre"><code>{body.join("\n")}</code></pre>);
        continue;
      }
      if (/^>\s?/.test(l)) {
        const q: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
        out.push(<blockquote key={n++} className="ch-quote">{q.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x, ctx, rules, `q${n}-${j}`)}</Fragment>)}</blockquote>);
        continue;
      }
      if (/^\s*([-*•])\s+/.test(l)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•])\s+/, ""));
        out.push(<ul key={n++} className="ch-ul">{items.map((x, j) => <li key={j}>{inline(x, ctx, rules, `u${n}-${j}`)}</li>)}</ul>);
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        const items: string[] = [];
        const start = Number(/^\s*(\d+)/.exec(l)![1]);
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
        out.push(<ol key={n++} className="ch-ol" start={start}>{items.map((x, j) => <li key={j}>{inline(x, ctx, rules, `o${n}-${j}`)}</li>)}</ol>);
        continue;
      }
      // Plain lines, kept together with line breaks.
      const para: string[] = [];
      while (i < lines.length && !/^(\s*```|>\s?|\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) {
        para.push(lines[i++]);
      }
      out.push(<div key={n++} className="ch-p">{para.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x, ctx, rules, `p${n}-${j}`)}</Fragment>)}</div>);
    }
    return out;
  }, [text, ctx, rules]);
  // A message that's only one to three emoji shows them large.
  const onlyEmoji = big !== false && /^(\s*(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*|:[a-z0-9_+-]+:)\s*){1,3}$/u.test(text) && !/^\s*\d/.test(text);
  return <div className={`ch-body${onlyEmoji ? " jumbo" : ""}`}>{blocks}</div>;
}
