"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { useBrand } from "@/components/BrandProvider";

type Line = { role: "user" | "assistant"; text: string };
type Phase = "connecting" | "listening" | "speaking" | "reconnecting" | "ended" | "error";

/**
 * A live, two-way voice conversation with Forge (OpenAI Realtime over
 * WebRTC). Requests to change the app are handed to the chat as messages,
 * or to quick edit when an element is selected. The transcript is saved to
 * the chat when the call ends.
 */
export default function VoiceSession({
  projectId,
  onSendToChat,
  onClose,
}: {
  projectId: string;
  onSendToChat: (text: string, mode: "build" | "ask" | "quick_edit") => void;
  onClose: () => void;
}) {
  const brand = useBrand();
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  // Out of credits (402) or over the daily limit (429): point to billing.
  const [upsell, setUpsell] = useState<"credits" | "limit" | null>(null);
  const [muted, setMuted] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const linesRef = useRef<Line[]>([]);
  const started = useRef(Date.now());
  const ended = useRef(false);
  const reconnects = useRef(0);
  const sendRef = useRef(onSendToChat);
  sendRef.current = onSendToChat;

  function addLine(line: Line) {
    linesRef.current = [...linesRef.current, line];
    setLines(linesRef.current);
  }

  async function connect() {
    const res = await fetch(`/api/projects/${projectId}/voice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    const s = await res.json().catch(() => ({}));
    if (!res.ok) {
      setUpsell(res.status === 402 ? "credits" : res.status === 429 ? "limit" : null);
      throw new Error(s.error ?? "Couldn't start voice.");
    }
    setSecondsLeft(s.secondsLeft);

    const peer = new RTCPeerConnection();
    pc.current = peer;
    audio.current ??= Object.assign(document.createElement("audio"), { autoplay: true });
    peer.ontrack = (e) => {
      if (audio.current) audio.current.srcObject = e.streams[0];
    };
    mic.current ??= await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of mic.current.getTracks()) peer.addTrack(t, mic.current);

    const events = peer.createDataChannel("oai-events");
    // Knowledge first: what was said is looked up in the company knowledge base, added to the conversation, and only then is a reply asked for.
    const lookup = (text: string): Promise<string> =>
      fetch(`/api/projects/${projectId}/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "kb", text }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((k) => (k?.context as string | undefined) ?? "")
        .catch(() => "");
    const reply = async (said: string) => {
      const context = said ? await lookup(said) : "";
      if (events.readyState !== "open") return;
      if (context) events.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: context }] } }));
      events.send(JSON.stringify({ type: "response.create" }));
    };
    events.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      switch (ev.type) {
        case "input_audio_buffer.speech_started":
        case "output_audio_buffer.stopped":
          setPhase("listening");
          break;
        case "output_audio_buffer.started":
          setPhase("speaking");
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (ev.transcript?.trim()) addLine({ role: "user", text: ev.transcript.trim() });
          void reply(ev.transcript?.trim() ?? "");
          break;
        case "conversation.item.input_audio_transcription.failed":
          void reply("");
          break;
        case "response.output_audio_transcript.done":
          if (ev.transcript?.trim()) addLine({ role: "assistant", text: ev.transcript.trim() });
          break;
        case "response.function_call_arguments.done": {
          let args: { text?: string; mode?: "build" | "ask" | "quick_edit"; query?: string } = {};
          try {
            args = JSON.parse(ev.arguments);
          } catch {}
          const answer = (output: string) => {
            events.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output } }));
            events.send(JSON.stringify({ type: "response.create" }));
          };
          if (ev.name === "search_company_knowledge") {
            void lookup(args.query ?? "").then((c) => answer(c || "The knowledge base couldn't be searched just now."));
            break;
          }
          if (ev.name === "send_to_chat" && args.text) sendRef.current(args.text, args.mode ?? "build");
          answer("Sent to the chat.");
          break;
        }
      }
    };
    peer.onconnectionstatechange = () => {
      if (ended.current) return;
      if (peer.connectionState === "connected") setPhase("listening");
      // Resume after a dropped connection, a couple of times.
      if ((peer.connectionState === "failed" || peer.connectionState === "disconnected") && reconnects.current < 2) {
        reconnects.current++;
        setPhase("reconnecting");
        peer.close();
        void connect().catch((e) => fail(e));
      }
    };

    await peer.setLocalDescription(await peer.createOffer());
    const answer = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(s.model)}`, {
      method: "POST",
      body: peer.localDescription?.sdp,
      headers: { authorization: `Bearer ${s.clientSecret}`, "content-type": "application/sdp" },
    });
    if (!answer.ok) throw new Error(`The voice service refused the call (HTTP ${answer.status}).`);
    await peer.setRemoteDescription({ type: "answer", sdp: await answer.text() });
  }

  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    setPhase("error");
  }

  async function end() {
    if (ended.current) return;
    ended.current = true;
    pc.current?.close();
    mic.current?.getTracks().forEach((t) => t.stop());
    setPhase("ended");
    const seconds = Math.round((Date.now() - started.current) / 1000);
    await fetch(`/api/projects/${projectId}/voice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "end", seconds, transcript: linesRef.current }),
    }).catch(() => undefined);
    onClose();
  }

  useEffect(() => {
    void connect().catch(fail);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 1000);
    return () => {
      clearInterval(t);
      if (!ended.current) {
        ended.current = true;
        pc.current?.close();
        mic.current?.getTracks().forEach((tr) => tr.stop());
      }
    };
    // Connect once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Daily limit: end the call when the time runs out.
  const left = secondsLeft === null ? null : Math.max(0, secondsLeft - elapsed);
  useEffect(() => {
    if (left === 0 && phase !== "ended") {
      addLine({ role: "assistant", text: "You've reached your voice time limit for today." });
      void end();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const label: Record<Phase, string> = {
    connecting: "Connecting…",
    listening: "Listening",
    speaking: `${brand.shortName} is speaking`,
    reconnecting: "Connection dropped — reconnecting…",
    ended: "Call ended",
    error: "Voice stopped",
  };
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

  return (
    <div className="mx-3 mb-2 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }} role="region" aria-label="Voice mode">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2" role="status">
          {phase === "connecting" || phase === "reconnecting" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <span className={`h-2.5 w-2.5 rounded-full ${phase === "speaking" ? "animate-pulse bg-[#6d4aff]" : phase === "listening" ? "bg-emerald-500" : "bg-zinc-400"}`} />
          )}
          {muted && phase === "listening" ? "Muted" : label[phase]}
          <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
            {mmss(elapsed)}
            {left !== null && ` · ${mmss(left)} left today`}
          </span>
        </span>
        <span className="flex gap-1.5">
          <button
            onClick={() => {
              const next = !muted;
              setMuted(next);
              mic.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
            }}
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"}
            className="rounded-lg border p-1.5"
          >
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <button onClick={() => void end()} aria-label="End call" className="rounded-lg bg-red-500 p-1.5 text-white">
            <PhoneOff className="h-4 w-4" />
          </button>
        </span>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
          {upsell && (
            <>
              {" "}
              <Link href="/settings/billing" className="font-medium underline">
                {upsell === "credits" ? "Add credits" : "See plans with more voice time"}
              </Link>
            </>
          )}
        </p>
      )}
      {lines.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs" aria-label="Live transcript">
          {lines.map((l, i) => (
            <li key={i}>
              <span className="font-medium">{l.role === "user" ? "You" : brand.shortName}:</span> {l.text}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10px]" style={{ color: "var(--muted)" }}>
        Your voice is processed by OpenAI and not stored. {brand.shortName} saves a transcript to this chat.
      </p>
    </div>
  );
}
