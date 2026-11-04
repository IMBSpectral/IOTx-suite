"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, MessageSquarePlus, Send, Shapes, X } from "lucide-react";

type Artifact = { id: string; title: string; kind: "svg" | "html" | "doc"; createdAt: string };
type Comment = { quote: string; note: string };

/**
 * Artifacts: the documents and visual explanations the agent made for this
 * project. Documents can be reviewed: select a passage, comment on it, and
 * send the comments to the agent together (each quoted as context).
 */
export default function ArtifactsPanel({
  projectId,
  initialId,
  onSend,
}: {
  projectId: string;
  initialId?: string | null;
  onSend: (text: string) => void;
}) {
  const [list, setList] = useState<Artifact[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [pick, setPick] = useState<{ text: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ quote: string; note: string } | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const docRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/artifacts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setList(d.artifacts);
        setSelected((s) => s ?? d.artifacts[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);

  const current = list?.find((a) => a.id === selected) ?? null;

  useEffect(() => {
    if (!current || current.kind !== "doc") return;
    let live = true;
    fetch(`/api/projects/${projectId}/artifacts?id=${current.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setMarkdown(d?.markdown ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, current]);

  function onMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel?.rangeCount || !docRef.current?.contains(sel.anchorNode)) return setPick(null);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const box = docRef.current.getBoundingClientRect();
    setPick({ text: text.slice(0, 500), x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + docRef.current.scrollTop });
  }

  function send() {
    if (!current || !comments.length) return;
    const body = comments.map((c, i) => `${i + 1}. On "${c.quote}":\n   ${c.note}`).join("\n\n");
    onSend(`Review comments on the document "${current.title}". Revise it with create_document, keeping everything else:\n\n${body}`);
    setComments([]);
  }

  if (!list) return <p className="p-6 text-sm" style={{ color: "var(--muted)" }}>Loading artifacts…</p>;
  if (!list.length) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm" style={{ color: "var(--muted)" }}>
        <p>
          Documents and visual explanations the agent creates appear here.
          <br />
          Try: &ldquo;Write a launch checklist for this app&rdquo; or &ldquo;Draw how the data flows&rdquo;.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-56 shrink-0 overflow-y-auto border-r p-2" aria-label="Artifacts">
        {list.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              setSelected(a.id);
              setMarkdown(null);
              setPick(null);
              setComments([]);
            }}
            className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${selected === a.id ? "bg-black/[.06] dark:bg-white/[.08]" : "hover:bg-black/[.04] dark:hover:bg-white/[.05]"}`}
          >
            {a.kind === "doc" ? <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Shapes className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span className="min-w-0">
              <span className="block truncate font-medium">{a.title}</span>
              <span style={{ color: "var(--muted)" }}>{new Date(a.createdAt).toLocaleDateString()}</span>
            </span>
          </button>
        ))}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {current?.kind === "doc" ? (
          <>
            <div ref={docRef} onMouseUp={onMouseUp} className="relative min-h-0 flex-1 overflow-y-auto px-8 py-6">
              <article className="prose-chat max-w-3xl text-sm leading-relaxed">
                {markdown === null ? <p>Loading…</p> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>}
              </article>
              {pick && !draft && (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setDraft({ quote: pick.text, note: "" });
                    setPick(null);
                  }}
                  className="absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-lg border px-2 py-1 text-xs shadow-lg"
                  style={{ left: pick.x, top: pick.y - 6, background: "var(--panel)" }}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" /> Comment
                </button>
              )}
            </div>
            {(draft || comments.length > 0) && (
              <div className="space-y-2 border-t p-3 text-xs">
                {comments.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Review comments">
                    {comments.map((c, i) => (
                      <li key={i} className="flex max-w-xs items-center gap-1 rounded-full border px-2 py-0.5" title={`"${c.quote}" — ${c.note}`}>
                        <span className="truncate">
                          &ldquo;{c.quote.slice(0, 40)}&rdquo; · {c.note.slice(0, 40)}
                        </span>
                        <button onClick={() => setComments((cs) => cs.filter((_, j) => j !== i))} aria-label="Remove comment">
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {draft && (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!draft.note.trim()) return;
                      setComments((cs) => [...cs, { quote: draft.quote, note: draft.note.trim() }]);
                      setDraft(null);
                    }}
                  >
                    <span className="max-w-[40%] truncate self-center italic" style={{ color: "var(--muted)" }}>
                      &ldquo;{draft.quote}&rdquo;
                    </span>
                    <input
                      autoFocus
                      value={draft.note}
                      onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                      placeholder="What should change?"
                      aria-label="Comment"
                      className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1"
                    />
                    <button className="rounded-lg border px-2.5">Add</button>
                    <button type="button" onClick={() => setDraft(null)} className="px-1" aria-label="Cancel comment">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                )}
                {comments.length > 0 && !draft && (
                  <button onClick={send} className="btn-primary flex items-center gap-1 rounded-lg px-3 py-1.5">
                    <Send className="h-3.5 w-3.5" /> Send {comments.length} comment{comments.length === 1 ? "" : "s"} to the agent
                  </button>
                )}
              </div>
            )}
          </>
        ) : current ? (
          <iframe src={`/api/projects/${projectId}/visuals/${current.id}`} title={current.title} sandbox="allow-scripts" className="h-full w-full" />
        ) : null}
      </section>
    </div>
  );
}
