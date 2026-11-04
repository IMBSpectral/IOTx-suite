"use client";

import { useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

function recognizer(): Recognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/**
 * Tap to transcribe: speech goes into the message box as text, where it can
 * be edited before sending. Uses the browser's own speech recognition.
 */
export default function DictateButton({ onText }: { onText: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);

  function toggle() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = recognizer();
    if (!r) {
      setHint("Dictation isn't supported in this browser. Try Chrome or Edge.");
      setTimeout(() => setHint(null), 4000);
      return;
    }
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript;
      if (text.trim()) onText(text.trim());
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed") setHint("Allow microphone access to dictate.");
      setTimeout(() => setHint(null), 4000);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  }

  return (
    <span className="relative">
      <button
        onClick={toggle}
        aria-pressed={listening}
        aria-label={listening ? "Stop dictation" : "Dictate"}
        title={listening ? "Listening… tap to stop" : "Tap to transcribe"}
        className={`rounded-md p-1 hover:bg-black/[.05] dark:hover:bg-white/[.08] ${listening ? "text-red-500" : ""}`}
        style={listening ? undefined : { color: "var(--muted)" }}
      >
        {listening ? <MicOff className="h-4 w-4 animate-pulse" /> : <Mic className="h-4 w-4" />}
      </button>
      {hint && (
        <span role="status" className="absolute bottom-full left-0 mb-1 w-56 rounded-lg border px-2 py-1 text-[11px] shadow" style={{ background: "var(--panel)" }}>
          {hint}
        </span>
      )}
    </span>
  );
}
