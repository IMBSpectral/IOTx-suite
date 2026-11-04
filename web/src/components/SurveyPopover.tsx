"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Survey = { id: string; question: string; followUp: string };

/** A one-time survey in the corner of the editor, once someone has used Forge a little. */
export default function SurveyPopover() {
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    // Not on load: give the page a moment first.
    const t = setTimeout(() => {
      fetch("/api/survey")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => live && d?.survey && setSurvey(d.survey))
        .catch(() => undefined);
    }, 20_000);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, []);

  async function send(body: Record<string, unknown>) {
    await fetch("/api/survey", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  }

  if (!survey) return null;
  if (done) {
    return (
      <div role="status" className="fixed bottom-4 right-4 z-40 rounded-xl border px-4 py-3 text-xs shadow-xl" style={{ background: "var(--panel)" }}>
        Thanks for the feedback!
      </div>
    );
  }
  return (
    <div role="dialog" aria-label="Quick survey" className="fixed bottom-4 right-4 z-40 w-80 rounded-xl border p-4 text-xs shadow-xl" style={{ background: "var(--panel)" }}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{survey.question}</p>
        <button
          onClick={() => {
            void send({ dismissed: true });
            setSurvey(null);
          }}
          aria-label="Dismiss survey"
          className="rounded p-0.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-11 gap-0.5" role="radiogroup" aria-label="Score from 0 to 10">
        {Array.from({ length: 11 }, (_, n) => (
          <button
            key={n}
            role="radio"
            aria-checked={score === n}
            onClick={() => setScore(n)}
            className={`rounded-md border py-1 text-[11px] ${score === n ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium" : ""}`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px]" style={{ color: "var(--muted)" }}>
        <span>Not likely</span>
        <span>Very likely</span>
      </div>
      {score !== null && (
        <>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={survey.followUp}
            aria-label={survey.followUp}
            rows={2}
            className="mt-3 w-full resize-none rounded-lg border bg-transparent px-2 py-1.5"
          />
          <button
            onClick={() => {
              void send({ score, answer });
              setDone(true);
              setTimeout(() => setSurvey(null), 2500);
            }}
            className="btn-primary mt-2 w-full rounded-lg py-1.5"
          >
            Send
          </button>
        </>
      )}
    </div>
  );
}
