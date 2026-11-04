"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { unifiedMergeView } from "@codemirror/merge";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { editorTheme, languageFor } from "./cm-setup";
import { canFormat, formatCode } from "./format";

/**
 * The Code tab's editor: CodeMirror 6 with highlighting, line numbers, folding,
 * bracket matching, indentation guides, search (Ctrl+F), Ctrl+S to save and
 * Shift+Alt+F to format with Prettier. With `original` it shows the file as
 * an inline diff against that text (what the last build changed).
 *
 * Uncontrolled: it starts from `initial` and reports edits through onChange;
 * the parent remounts it (a new key) to load another file or version.
 */
export default function CodeEditor({
  path,
  initial,
  line,
  readOnly,
  wrap,
  dark,
  original,
  formatTick,
  onChange,
  onSave,
  onFormatStatus,
}: {
  path: string;
  initial: string;
  /** Select this line (1-based) when the file opens. */
  line?: number | null;
  readOnly: boolean;
  wrap: boolean;
  dark: boolean;
  /** The text to diff against; null shows the whole file as new; undefined shows no diff. */
  original?: string | null;
  /** Bump to format the document (the toolbar's Format button). */
  formatTick: number;
  onChange: (text: string) => void;
  onSave: () => void;
  onFormatStatus?: (message: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const comp = useRef({ readOnly: new Compartment(), wrap: new Compartment(), theme: new Compartment(), diff: new Compartment() });
  const cb = useRef({ onChange, onSave, onFormatStatus, readOnly });
  useEffect(() => {
    cb.current = { onChange, onSave, onFormatStatus, readOnly };
  });

  async function runFormat() {
    const v = view.current;
    if (!v || cb.current.readOnly) return;
    if (!canFormat(path)) {
      cb.current.onFormatStatus?.("Prettier doesn't format this file type.");
      return;
    }
    const text = v.state.doc.toString();
    cb.current.onFormatStatus?.("Formatting…");
    try {
      const out = await formatCode(path, text, v.state.selection.main.head);
      // The person may have typed while Prettier loaded: only apply to the text it formatted.
      if (view.current !== v || v.state.doc.toString() !== text) return cb.current.onFormatStatus?.(null);
      if (out.formatted !== text) {
        const at = Math.min(out.cursorOffset < 0 ? 0 : out.cursorOffset, out.formatted.length);
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: out.formatted }, selection: EditorSelection.cursor(at), scrollIntoView: true });
      }
      cb.current.onFormatStatus?.(out.formatted === text ? "Already formatted" : "Formatted");
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : "Couldn't format";
      cb.current.onFormatStatus?.(`Couldn't format: ${msg.slice(0, 160)}`);
    }
  }
  const formatRef = useRef(runFormat);
  useEffect(() => {
    formatRef.current = runFormat;
  });

  // Created once per mount; the parent keys the component by file.
  useEffect(() => {
    if (!host.current) return;
    const c = comp.current;
    const state = EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        indentationMarkers({ thickness: 1, colors: { light: "#e4e4e8", dark: "#2f2f37", activeLight: "#b9b9c2", activeDark: "#55555f" } }),
        search({ top: true }),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          { key: "Shift-Alt-f", preventDefault: true, run: () => (void formatRef.current(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        languageFor(path),
        c.theme.of(editorTheme(dark)),
        c.wrap.of(wrap ? EditorView.lineWrapping : []),
        c.readOnly.of([EditorState.readOnly.of(readOnly)]),
        c.diff.of(original === undefined ? [] : unifiedMergeView({ original: original ?? "", mergeControls: false, gutter: true })),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": `Code: ${path}` }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    if (line && line > 0) {
      const l = v.state.doc.line(Math.min(line, v.state.doc.lines));
      v.dispatch({ selection: EditorSelection.range(l.from, l.to), effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      v.focus();
    }
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.theme.reconfigure(editorTheme(dark)) });
  }, [dark]);
  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);
  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly)]) });
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({
      effects: comp.current.diff.reconfigure(original === undefined ? [] : unifiedMergeView({ original: original ?? "", mergeControls: false, gutter: true })),
    });
  }, [original]);
  // Only presses made while this file is open (the tick carries over from other files).
  const tickAtMount = useRef(formatTick);
  useEffect(() => {
    if (formatTick !== tickAtMount.current) void formatRef.current();
  }, [formatTick]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-code-editor />;
}
