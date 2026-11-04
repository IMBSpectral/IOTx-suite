"use client";

import { useState } from "react";

/**
 * Clarifying questions the agent asked before building. Each question takes a
 * suggested option or the user's own words; the answers go back as the next
 * message, which is what the agent is waiting for.
 */
export default function QuestionsCard({
  questions,
  disabled,
  onSubmit,
}: {
  questions: { question: string; options?: string[] }[];
  disabled?: boolean;
  onSubmit: (text: string) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const set = (i: number, v: string) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
  const ready = answers.some((a) => a.trim());

  function submit() {
    const lines = questions.map(
      (q, i) => `**${q.question}**\n${answers[i].trim() || "No preference — you decide."}`,
    );
    onSubmit(`Here are my answers:\n\n${lines.join("\n\n")}`);
  }

  return (
    <div className="mt-3 rounded-xl border p-3" style={{ background: "var(--panel)" }}>
      <p className="text-xs font-medium">A few questions before building</p>
      <div className="mt-2 space-y-3">
        {questions.map((q, i) => (
          <div key={i}>
            <p className="text-[13px]">{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {q.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => set(i, o)}
                    aria-pressed={answers[i] === o}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      answers[i] === o
                        ? "border-[#6d4aff] bg-[#6d4aff]/10"
                        : "hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
            <input
              value={q.options?.includes(answers[i]) ? "" : answers[i]}
              onChange={(e) => set(i, e.target.value)}
              placeholder="Or answer in your own words…"
              aria-label={`Answer: ${q.question}`}
              className="mt-1.5 w-full rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSubmit("Skip the questions — use your best judgement and build it.")}
          className="rounded-md px-2.5 py-1 text-xs hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]"
          style={{ color: "var(--muted)" }}
        >
          Skip
        </button>
        <button
          type="button"
          disabled={disabled || !ready}
          onClick={submit}
          className="rounded-md bg-[#6d4aff] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Send answers
        </button>
      </div>
    </div>
  );
}
