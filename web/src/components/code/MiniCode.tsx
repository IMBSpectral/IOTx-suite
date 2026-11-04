"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { editorTheme, languageFor } from "./cm-setup";

/**
 * A small read-only, highlighted view of a file's code: the chat's file cards
 * and the build view's "code being written" panel. New text that extends the
 * old is appended (so streaming code doesn't re-render the whole file), and
 * with `follow` it keeps the end in view.
 */
export default function MiniCode({ path, code, dark, follow = false, numbers = true }: { path: string; code: string; dark: boolean; follow?: boolean; numbers?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const theme = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          numbers ? lineNumbers() : [],
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          languageFor(path),
          theme.current.of(editorTheme(dark, "11.5px")),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The path fixes the language; the parent keys by path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(dark, "11.5px")) });
  }, [dark]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const now = v.state.doc;
    if (now.length > 0 && code.length >= now.length && code.slice(0, now.length) === now.toString()) {
      if (code.length > now.length) v.dispatch({ changes: { from: now.length, insert: code.slice(now.length) } });
    } else {
      v.dispatch({ changes: { from: 0, to: now.length, insert: code } });
    }
    if (follow) {
      v.requestMeasure({
        read: () => null,
        write: () => {
          v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
        },
      });
    }
  }, [code, follow]);

  return <div ref={host} className="mini-code h-full min-h-0 overflow-hidden" />;
}
