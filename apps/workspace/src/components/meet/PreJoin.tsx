"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { colorFor, initials } from "./api";

export type Choices = { video: boolean; audio: boolean; videoDeviceId?: string; audioDeviceId?: string; audioOutputId?: string };

/**
 * Camera and microphone check before joining: live preview, a mic level
 * meter, device pickers. Works without a camera or with permission denied
 * (people can still join and listen).
 */
export default function PreJoin({
  name,
  defaultAudio,
  children,
  onChange,
}: {
  name: string;
  defaultAudio: boolean;
  children: React.ReactNode;
  onChange: (c: Choices) => void;
}) {
  const [video, setVideo] = useState(true);
  const [audio, setAudio] = useState(defaultAudio);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [outId, setOutId] = useState<string>("");
  const [camErr, setCamErr] = useState("");
  const [micErr, setMicErr] = useState("");
  const [level, setLevel] = useState(0);
  const videoEl = useRef<HTMLVideoElement>(null);
  const camStream = useRef<MediaStream | null>(null);

  const refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setCams(all.filter((d) => d.kind === "videoinput" && d.deviceId));
      setMics(all.filter((d) => d.kind === "audioinput" && d.deviceId));
      setOuts(all.filter((d) => d.kind === "audiooutput" && d.deviceId));
    } catch {}
  };

  useEffect(() => {
    onChange({ video: video && !camErr, audio: audio && !micErr, videoDeviceId: camId || undefined, audioDeviceId: micId || undefined, audioOutputId: outId || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, audio, camId, micId, outId, camErr, micErr]);

  // Camera preview.
  useEffect(() => {
    let cancelled = false;
    camStream.current?.getTracks().forEach((t) => t.stop());
    camStream.current = null;
    if (!video || !navigator.mediaDevices?.getUserMedia) return;
    navigator.mediaDevices
      .getUserMedia({ video: camId ? { deviceId: { exact: camId } } : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        camStream.current = s;
        setCamErr("");
        if (videoEl.current) videoEl.current.srcObject = s;
        refreshDevices();
      })
      .catch((e: Error) => setCamErr(e.name === "NotAllowedError" ? "Camera is blocked in this browser." : e.name === "NotFoundError" ? "No camera found." : "The camera isn't available."));
    return () => {
      cancelled = true;
    };
  }, [video, camId]);

  // Microphone level meter.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    if (!audio || !navigator.mediaDevices?.getUserMedia) {
      setLevel(0);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setMicErr("");
        refreshDevices();
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          an.getByteFrequencyData(buf);
          let sum = 0;
          for (const v of buf) sum += v;
          setLevel(Math.min(1, sum / buf.length / 90));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((e: Error) => setMicErr(e.name === "NotAllowedError" ? "Microphone is blocked in this browser." : "No microphone found."));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [audio, micId]);

  // Stop the preview when leaving this screen (LiveKit opens its own tracks).
  useEffect(
    () => () => {
      camStream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const showVideo = video && !camErr;
  return (
    <div className="mt-pre">
      <div>
        <div className="mt-preview">
          {showVideo ? (
            <video ref={videoEl} autoPlay playsInline muted />
          ) : (
            <span className="mt-avatar mt-avatar-lg" style={{ background: colorFor(name || "guest") }}>
              {initials(name || "Guest")}
            </span>
          )}
          <div className="mt-preview-bar">
            <button className={`mt-cbtn${audio && !micErr ? "" : " off"}`} onClick={() => setAudio((a) => !a)} aria-label={audio ? "Turn microphone off" : "Turn microphone on"} title="Microphone">
              {audio && !micErr ? <Mic size={20} /> : <MicOff size={20} />}
              {audio && !micErr && <span style={{ position: "absolute", bottom: 6, left: 12, right: 12, height: 3, borderRadius: 2, background: "rgba(255,255,255,.2)" }}><span style={{ display: "block", height: 3, borderRadius: 2, width: `${Math.round(level * 100)}%`, background: "#4ade80" }} /></span>}
            </button>
            <button className={`mt-cbtn${showVideo ? "" : " off"}`} onClick={() => setVideo((v) => !v)} aria-label={video ? "Turn camera off" : "Turn camera on"} title="Camera">
              {showVideo ? <Video size={20} /> : <VideoOff size={20} />}
            </button>
          </div>
        </div>
        {(camErr || micErr) && <p className="mt-note" style={{ marginTop: 8 }}>{[camErr, micErr].filter(Boolean).join(" ")} You can still join.</p>}
        <div className="mt-devices">
          <label>
            Camera
            <select className="mt-select" value={camId} onChange={(e) => setCamId(e.target.value)} disabled={!cams.length}>
              <option value="">{cams.length ? "Default camera" : "No camera"}</option>
              {cams.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
              ))}
            </select>
          </label>
          <label>
            Microphone
            <select className="mt-select" value={micId} onChange={(e) => setMicId(e.target.value)} disabled={!mics.length}>
              <option value="">{mics.length ? "Default microphone" : "No microphone"}</option>
              {mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
              ))}
            </select>
          </label>
          {outs.length > 0 && (
            <label>
              Speaker
              <select className="mt-select" value={outId} onChange={(e) => setOutId(e.target.value)}>
                <option value="">Default speaker</option>
                {outs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
