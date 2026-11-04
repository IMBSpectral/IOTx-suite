/**
 * The chat box's text editing (lib/composer-format): formatting, lists,
 * mention chips and atomic delete, and how a sent message is prepared.
 *   npx tsx scripts/test-composer-format.mts
 */
import { codeBlock, continueList, deleteMention, linkMentions, list, segments, wrap } from "../src/lib/composer-format";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const known = new Set(["src/App.tsx", "Stripe", "Sales CRM"]);

const b = wrap("make this bold", 10, 14, "**");
check("bold wraps the selection and keeps it selected", b.text === "make this **bold**" && b.text.slice(b.start, b.end) === "bold", JSON.stringify(b));
const u = wrap(b.text, b.start, b.end, "**");
check("bold again removes it", u.text === "make this bold" && u.text.slice(u.start, u.end) === "bold", JSON.stringify(u));
const sp = wrap("a  word  b", 1, 9, "_");
check("spaces around the selection stay outside the markers", sp.text === "a  _word_  b", sp.text);
const empty = wrap("x ", 2, 2, "`");
check("with nothing selected the caret lands between the markers", empty.text === "x ``" && empty.start === 3 && empty.end === 3);
const cb = codeBlock("see\nconst a = 1", 4, 15);
check("code block fences the selection on its own lines", cb.text === "see\n```\nconst a = 1\n```\n", JSON.stringify(cb.text));

const l = list("one\ntwo\nthree", 0, 13, "bullet");
check("bullets every selected line", l.text === "- one\n- two\n- three", JSON.stringify(l.text));
check("and toggles back", list(l.text, 0, l.text.length, "bullet").text === "one\ntwo\nthree");
check("numbered list counts", list("a\nb", 0, 3, "number").text === "1. a\n2. b");
const c1 = continueList("- first", 7);
check("Shift+Enter in a list continues it", c1?.text === "- first\n- " && c1.start === 10);
check("numbered lists count up", continueList("1. a\n2. b", 9)?.text === "1. a\n2. b\n3. ");
check("an empty item ends the list", continueList("- a\n- ", 6)?.text === "- a\n");
check("outside a list nothing happens", continueList("hello", 5) === null);

const t = "fix @src/App.tsx now";
const d = deleteMention(t, 16, known);
check("backspace after a mention removes the whole mention", d?.text === "fix  now" && d.start === 4, JSON.stringify(d));
check("an unknown @word is left to normal backspace", deleteMention("ping @nobody", 12, known) === null);

const seg = segments("/plan use @Stripe and @src/App.tsx. Ask @nobody", known, new Set(["/plan"]));
check(
  "chips for the command and known mentions, a full stop isn't part of a mention",
  JSON.stringify(seg.filter((s) => s.kind !== "text").map((s) => s.text)) === JSON.stringify(["/plan", "@Stripe", "@src/App.tsx"]) && seg.map((s) => s.text).join("") === "/plan use @Stripe and @src/App.tsx. Ask @nobody",
  JSON.stringify(seg),
);

const md = linkMentions("Use @Stripe\nthen `@notachip` and\n```\n@code\n```\nmail me@x.com");
check("sent messages: mentions become chips, code and emails don't", md.includes("[@Stripe](mention:Stripe)") && md.includes("`@notachip`") && md.includes("\n@code\n") && md.includes("me@x.com") && !md.includes("[@x"), JSON.stringify(md));
check("single line breaks are kept", md.startsWith("Use [@Stripe](mention:Stripe)  \nthen"), JSON.stringify(md));

console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
process.exit(failures ? 1 : 0);
