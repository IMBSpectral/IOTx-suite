import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";

/** Syntax for a file, by its extension. Unknown types are plain text. */
export function languageFor(path: string): Extension {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "css":
      return css();
    case "html":
    case "htm":
    case "svg":
      return html();
    case "json":
      return json();
    case "md":
    case "mdx":
      return markdown();
    case "sql":
      return sql();
    default:
      return [];
  }
}

// Colours close to GitHub's light and dark code themes.
const light = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#cf222e" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a3069" },
  { tag: [t.comment, t.meta], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#0550ae" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.tagName, t.angleBracket], color: "#116329" },
  { tag: [t.attributeName, t.propertyName], color: "#0550ae" },
  { tag: t.definition(t.variableName), color: "#953800" },
  { tag: t.heading, color: "#0550ae", fontWeight: "600" },
  { tag: t.link, color: "#0a3069", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "#82071e" },
]);
const dark = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#ff7b72" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6ff" },
  { tag: [t.comment, t.meta], color: "#8b949e", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#d2a8ff" },
  { tag: [t.typeName, t.className, t.namespace], color: "#ffa657" },
  { tag: [t.tagName, t.angleBracket], color: "#7ee787" },
  { tag: [t.attributeName, t.propertyName], color: "#79c0ff" },
  { tag: t.definition(t.variableName), color: "#ffa657" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "600" },
  { tag: t.link, color: "#a5d6ff", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "#ffa198" },
]);

function chrome(isDark: boolean, size: string) {
  return EditorView.theme(
    {
      "&": { height: "100%", fontSize: size, backgroundColor: "transparent", color: "var(--text)" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.6" },
      ".cm-content": { caretColor: "var(--text)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
      ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "36px", opacity: "0.7" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
      ".cm-activeLine": { backgroundColor: isDark ? "rgb(255 255 255 / 0.04)" : "rgb(0 0 0 / 0.035)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: isDark ? "rgb(139 133 255 / 0.3)" : "rgb(79 70 229 / 0.18)",
      },
      ".cm-matchingBracket": { backgroundColor: isDark ? "rgb(255 255 255 / 0.12)" : "rgb(0 0 0 / 0.08)", outline: "1px solid rgb(127 127 127 / 0.4)" },
      ".cm-selectionMatch": { backgroundColor: isDark ? "rgb(255 255 255 / 0.08)" : "rgb(79 70 229 / 0.08)" },
      ".cm-searchMatch": { backgroundColor: "rgb(250 204 21 / 0.3)", outline: "1px solid rgb(250 204 21 / 0.6)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(250 160 21 / 0.45)" },
      ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "1px solid var(--border)", color: "var(--muted)", padding: "0 4px", borderRadius: "4px" },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
      ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
      ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px", fontFamily: "inherit" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px", borderRadius: "6px" },
      ".cm-textfield": { border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", padding: "2px 6px" },
      ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", padding: "2px 8px" },
      ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: "8px" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
      // Inline diff (the last build's changes).
      ".cm-changedLine": { backgroundColor: isDark ? "rgb(46 160 67 / 0.12)" : "rgb(46 160 67 / 0.1)" },
      ".cm-changedText": { backgroundColor: isDark ? "rgb(46 160 67 / 0.3)" : "rgb(46 160 67 / 0.25)" },
      ".cm-deletedChunk": { backgroundColor: isDark ? "rgb(248 81 73 / 0.12)" : "rgb(248 81 73 / 0.08)" },
      ".cm-deletedChunk .cm-deletedText": { backgroundColor: isDark ? "rgb(248 81 73 / 0.3)" : "rgb(248 81 73 / 0.2)" },
    },
    { dark: isDark },
  );
}

/** The editor's colours and syntax highlighting for the app's light or dark theme. */
export function editorTheme(isDark: boolean, size = "12.5px"): Extension {
  return [chrome(isDark, size), syntaxHighlighting(isDark ? dark : light)];
}
