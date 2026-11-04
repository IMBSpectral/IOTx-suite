"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Track, type LocalParticipant, type LocalVideoTrack } from "livekit-client";

/**
 * Camera background effects (blur and virtual backgrounds) with LiveKit's
 * track processors. The segmentation model and WASM are served from this
 * app (/workspace/meet-vision), not a CDN.
 */
export type Bg = { mode: "none" } | { mode: "blur"; radius: number } | { mode: "image"; src: string; label: string };

const ASSETS = { tasksVisionFileSet: "/workspace/meet-vision", modelAssetPath: "/workspace/meet-vision/selfie_segmenter.tflite" };
const BG_KEY = "iotx-meet-bg";

/** A few ready-made backgrounds, drawn on a canvas (no image files needed). */
export function presetBackgrounds(): { label: string; src: string }[] {
  if (typeof document === "undefined") return [];
  const make = (stops: string[], draw?: (c: CanvasRenderingContext2D) => void) => {
    const cv = document.createElement("canvas");
    cv.width = 1280;
    cv.height = 720;
    const c = cv.getContext("2d")!;
    const g = c.createLinearGradient(0, 0, 1280, 720);
    stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
    c.fillStyle = g;
    c.fillRect(0, 0, 1280, 720);
    draw?.(c);
    return cv.toDataURL("image/jpeg", 0.85);
  };
  return [
    { label: "Office", src: make(["#e9e4da", "#c9bfae"], (c) => { c.fillStyle = "rgba(255,255,255,.55)"; for (let i = 0; i < 4; i++) c.fillRect(120 + i * 280, 120, 200, 300); c.fillStyle = "#8a7a62"; c.fillRect(0, 560, 1280, 160); }) },
    { label: "Ocean", src: make(["#0f3057", "#00587a", "#00a8cc"]) },
    { label: "Sunset", src: make(["#ff9a8b", "#ff6a88", "#7b4397"]) },
    { label: "Forest", src: make(["#134e5e", "#71b280"]) },
    { label: "Studio", src: make(["#141e30", "#243b55"], (c) => { const r = c.createRadialGradient(640, 300, 40, 640, 300, 520); r.addColorStop(0, "rgba(255,255,255,.25)"); r.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = r; c.fillRect(0, 0, 1280, 720); }) },
  ];
}

export function useBackground(lp: LocalParticipant, cameraOn: boolean) {
  const [bg, setBgState] = useState<Bg>({ mode: "none" });
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState("");
  const proc = useRef<Awaited<ReturnType<typeof import("@livekit/track-processors")["BackgroundProcessor"]>> | null>(null);
  useEffect(() => {
    import("@livekit/track-processors").then((m) => setSupported(m.supportsBackgroundProcessors())).catch(() => setSupported(false));
    try {
      const saved = JSON.parse(localStorage.getItem(BG_KEY) ?? "null") as Bg | null;
      if (saved && saved.mode === "blur") setBgState(saved);
    } catch {}
  }, []);
  const apply = useCallback(async (next: Bg) => {
    setError("");
    const track = lp.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
    if (!track) return;
    try {
      const m = await import("@livekit/track-processors");
      if (next.mode === "none") {
        if (proc.current) await proc.current.switchTo({ mode: "disabled" });
        return;
      }
      const opts = next.mode === "blur" ? ({ mode: "background-blur", blurRadius: next.radius } as const) : ({ mode: "virtual-background", imagePath: next.src } as const);
      if (!proc.current || track.getProcessor() !== proc.current) {
        proc.current = m.BackgroundProcessor({ ...opts, assetPaths: ASSETS });
        await track.setProcessor(proc.current);
      } else await proc.current.switchTo(opts);
    } catch (e) {
      setError((e as Error).message || "Background effects aren't available on this device.");
    }
  }, [lp]);
  // Re-apply after the camera comes back on (a new track).
  useEffect(() => {
    if (cameraOn && bg.mode !== "none") {
      proc.current = null;
      const t = setTimeout(() => apply(bg), 300);
      return () => clearTimeout(t);
    }
  }, [cameraOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const setBg = useCallback((next: Bg) => {
    setBgState(next);
    try {
      localStorage.setItem(BG_KEY, JSON.stringify(next.mode === "blur" ? next : { mode: "none" }));
    } catch {}
    void apply(next);
  }, [apply]);
  return { bg, setBg, supported, error };
}

type SR = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; abort: () => void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
export const speechSupported = () => typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

/**
 * Live captions from my own microphone with the browser's speech
 * recognition. Interim text goes out over the data channel as I speak;
 * finished lines are also saved to the meeting transcript.
 */
export function useCaptionSender(on: boolean, lang: string, micOn: boolean, send: (text: string, final: boolean) => void) {
  const rec = useRef<SR | null>(null);
  const want = useRef(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    want.current = on && micOn && speechSupported();
    if (!want.current) {
      rec.current?.abort();
      rec.current = null;
      return;
    }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const r: SR = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = String(res[0]?.transcript ?? "").trim();
        if (text) send(text, !!res.isFinal);
      }
    };
    r.onerror = (e: any) => {
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        setErr("Captions need permission to use speech recognition.");
        want.current = false;
      }
    };
    // Recognition stops by itself after silence: keep it going while captions are on.
    r.onend = () => {
      if (want.current && rec.current === r) {
        try {
          r.start();
        } catch {}
      }
    };
    rec.current = r;
    try {
      r.start();
    } catch {}
    return () => {
      want.current = false;
      r.onend = null;
      r.abort();
    };
  }, [on, lang, micOn, send]);
  return err;
}

/**
 * Captions for browsers without speech recognition (Firefox, some Safari):
 * record a few seconds of my own microphone at a time and let the server
 * transcribe it (OpenAI). Chunks with no voice in them are never sent. The
 * server saves each line to the transcript; onText shows it and tells the room.
 */
export function useServerCaptions(on: boolean, micTrack: MediaStreamTrack | undefined, upload: (blob: Blob) => Promise<string>, onText: (text: string) => void) {
  const [err, setErr] = useState("");
  const cb = useRef({ upload, onText });
  cb.current = { upload, onText };
  useEffect(() => {
    if (!on || !micTrack || typeof MediaRecorder === "undefined") return;
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t));
    let stopped = false;
    let rec: MediaRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let fails = 0;
    // A level meter, so silent chunks are skipped.
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(new MediaStream([micTrack])).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let peak = 0;
    const meter = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v - 128));
      peak = Math.max(peak, m / 128);
    }, 100);
    const next = () => {
      if (stopped) return;
      const chunks: Blob[] = [];
      peak = 0;
      try {
        rec = new MediaRecorder(new MediaStream([micTrack]), mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      } catch {
        setErr("This browser can't record audio for captions.");
        return;
      }
      const voiced = () => peak > 0.06 && micTrack.enabled;
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const r = rec;
      rec.onstop = () => {
        const had = voiced();
        const type = (r.mimeType || mime || "audio/webm").split(";")[0];
        next();
        if (!had || !chunks.length) return;
        const blob = new Blob(chunks, { type });
        cb.current.upload(blob).then((text) => {
          fails = 0;
          if (text) cb.current.onText(text);
        }).catch((e) => {
          if (++fails === 3) setErr((e as Error).message || "Captions aren't working right now.");
        });
      };
      rec.start();
      timer = setTimeout(() => rec?.state === "recording" && rec.stop(), 5000);
    };
    next();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(meter);
      if (rec?.state === "recording") rec.stop();
      void ac.close().catch(() => {});
    };
  }, [on, micTrack]);
  return err;
}
