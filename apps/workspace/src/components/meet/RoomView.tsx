"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CarouselLayout,
  ConnectionQualityIndicator,
  FocusLayout,
  FocusLayoutContainer,
  GridLayout,
  LayoutContextProvider,
  LiveKitRoom,
  MediaDeviceMenu,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  useDataChannel,
  useIsRecording,
  useLayoutContext,
  useLocalParticipant,
  useLocalParticipantPermissions,
  useParticipantAttribute,
  useParticipants,
  usePinnedTracks,
  useRoomContext,
  useRoomInfo,
  useSpeakingParticipants,
  useTrackRefContext,
  useTracks,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { DisconnectReason, ExternalE2EEKeyProvider, Room, RoomEvent, Track, type LocalAudioTrack, type Participant } from "livekit-client";
import {
  BarChart3,
  Captions,
  ChevronUp,
  Circle,
  Copy,
  DoorOpen,
  Hand,
  Keyboard,
  LayoutGrid,
  Lock,
  LockOpen,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MoreVertical,
  NotebookPen,
  PenLine,
  PhoneOff,
  PictureInPicture2,
  Pin,
  Presentation,
  Settings2,
  ShieldCheck,
  Smile,
  Sparkles,
  Square,
  Star,
  Users,
  Video,
  VideoOff,
  VolumeX,
  X,
  Split,
  Info,
  Radio,
  Megaphone,
} from "lucide-react";
import type { Choices } from "./PreJoin";
import { colorFor, initials, meetApi, type JoinReply, type MeetingInfo } from "./api";
import { presetBackgrounds, speechSupported, useBackground, useCaptionSender, useServerCaptions } from "./effects";
import { aiNoiseSupported, rnnoiseProcessor } from "./noise";
import { InfoPanel, inviteText, StreamPanel, WebinarPanel } from "./Plus";
import { BreakoutPanel, ChatPanel, PollsPanel, QAPanel, Whiteboard, useMeetChat, type BoState, type Ctx } from "./Panels";

export type Admitted = Extract<JoinReply, { status: "admitted" }> & { room?: number; roomName?: string };
type LeaveWhy = "left" | "removed" | "ended" | "error";
type HostInfo = {
  settings: { waitingRoom: boolean; allowGuests: boolean; muteOnEntry: boolean; locked: boolean; everyoneWaits: boolean; hasPasscode: boolean; passcode: string | null; captions: boolean; captionLang: string; registration?: boolean; regApproval?: boolean };
  dialIn?: import("./api").DialIn | null;
  waiting: number;
  notesStatus: string;
  owner: boolean;
  can: { record: boolean; aiNotes: boolean; guests: boolean };
};
type Waiting = { id: string; name: string; since: string; kind: string };
type RoomMeta = { kind?: string; e2ee?: boolean; live?: boolean; stage?: string[]; locked?: boolean; recording?: boolean; notes?: boolean; title?: string; host?: string; coHosts?: string[]; spotlight?: string | null; captions?: boolean; captionLang?: string; breakout?: { open: boolean } | null };
type Panel = "" | "chat" | "people" | "polls" | "qa" | "breakout" | "effects" | "host" | "keys" | "webinar" | "live" | "info";

const EMOJIS = ["👍", "👏", "😂", "❤️", "🎉", "😮", "🙏", "🤔"];
const LANGS = [["en-US", "English (US)"], ["en-IN", "English (India)"], ["en-GB", "English (UK)"], ["hi-IN", "Hindi"], ["mr-IN", "Marathi"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"], ["bn-IN", "Bengali"], ["gu-IN", "Gujarati"], ["kn-IN", "Kannada"], ["es-ES", "Spanish"], ["fr-FR", "French"], ["de-DE", "German"], ["ar-SA", "Arabic"], ["zh-CN", "Chinese"], ["ja-JP", "Japanese"]];
const TRANSLATE = ["English", "Hindi", "Marathi", "Tamil", "Telugu", "Bengali", "Gujarati", "Kannada", "Spanish", "French", "German", "Arabic", "Chinese", "Japanese"];
const enc = new TextEncoder();
const dec = new TextDecoder();
const parse = (p: Uint8Array) => {
  try {
    return JSON.parse(dec.decode(p)) as Record<string, any>;
  } catch {
    return {};
  }
};
const roleOf = (p: Participant) => {
  try {
    return (JSON.parse(p.metadata || "{}") as { role?: string }).role ?? "member";
  } catch {
    return "member";
  }
};
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export default function RoomView({ info, join, choices, guest, onLeave, onSwitch, secret = null }: {
  info: MeetingInfo; join: Admitted; choices: Choices; guest: string | null;
  onLeave: (why: LeaveWhy, message?: string) => void; onSwitch: (j: Admitted) => void;
  /** End-to-end encryption key (never sent to the server). */
  secret?: string | null;
}) {
  const leaving = useRef(false);
  // End-to-end encryption: LiveKit's key provider and its worker (served from /workspace/meet-e2ee).
  const e2ee = useMemo(() => {
    if (!secret) return null;
    const keyProvider = new ExternalE2EEKeyProvider();
    const worker = new Worker("/workspace/meet-e2ee/livekit-client.e2ee.worker.mjs", { type: "module" });
    return { keyProvider, worker };
  }, [secret]);
  const lkRoom = useMemo(
    () => new Room({ adaptiveStream: true, dynacast: true, audioOutput: choices.audioOutputId ? { deviceId: choices.audioOutputId } : undefined, publishDefaults: { simulcast: true }, ...(e2ee ? { e2ee } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [e2ee],
  );
  const [ready, setReady] = useState(!secret);
  const [e2eeErr, setE2eeErr] = useState("");
  useEffect(() => {
    if (!e2ee || !secret) return;
    let off = false;
    e2ee.keyProvider
      .setKey(secret)
      .then(() => lkRoom.setE2EEEnabled(true))
      .then(() => !off && setReady(true))
      .catch((e) => !off && setE2eeErr((e as Error).message || "Encryption couldn't start in this browser."));
    const onErr = () => setE2eeErr("Some media couldn't be decrypted. Check that everyone used the same invite link.");
    lkRoom.on(RoomEvent.EncryptionError, onErr);
    return () => {
      off = true;
      lkRoom.off(RoomEvent.EncryptionError, onErr);
    };
  }, [e2ee, secret, lkRoom]);
  useEffect(() => () => e2ee?.worker.terminate(), [e2ee]);
  if (e2eeErr && !ready)
    return (
      <div className="mt-root mt-dark"><div className="mt-center"><h1>Encryption couldn&apos;t start</h1><p>{e2eeErr}</p></div></div>
    );
  const audioOn = choices.audio && !(join.settings.muteOnEntry && join.role !== "host" && !join.room);
  const strong = store.get("iotx-meet-ns") === "strong";
  const audioOpts = { deviceId: choices.audioDeviceId, echoCancellation: true, noiseSuppression: store.get("iotx-meet-ns") !== "ai", autoGainControl: true, ...(strong ? { voiceIsolation: true } : {}) };
  return (
    <div className="mt-root mt-dark" data-lk-theme="default">
      <LiveKitRoom
        serverUrl={join.url}
        token={join.token}
        room={lkRoom}
        connect={ready}
        video={choices.video ? (choices.videoDeviceId ? { deviceId: choices.videoDeviceId } : true) : false}
        audio={audioOn ? audioOpts : false}
        className="mt-room"
        onDisconnected={(reason) => {
          if (leaving.current) return;
          if (reason === DisconnectReason.PARTICIPANT_REMOVED) onLeave("removed");
          else if (reason === DisconnectReason.ROOM_DELETED) join.room ? onSwitch({ ...join, room: 0 }) : onLeave("ended");
          else if (reason === DisconnectReason.CLIENT_INITIATED) onLeave("left");
          else if (reason === DisconnectReason.DUPLICATE_IDENTITY) onLeave("error", "You joined this meeting from another tab or device.");
          else onLeave("error");
        }}
        onError={(e) => console.warn("[meet]", e)}
      >
        <LayoutContextProvider>
          <Inner info={info} join={join} guest={guest} leaving={leaving} onLeave={onLeave} onSwitch={onSwitch} choices={choices} secret={secret} />
        </LayoutContextProvider>
        <RoomAudioRenderer />
        <StartAudio label="Tap to turn on meeting audio" />
      </LiveKitRoom>
    </div>
  );
}

function Tile({ trackRef, spotlight }: { trackRef?: TrackReferenceOrPlaceholder; spotlight?: string | null }) {
  const ctx = useTrackRefContext();
  const ref = trackRef ?? ctx;
  const hand = useParticipantAttribute("hand", { participant: ref.participant });
  return (
    <div style={{ position: "relative", height: "100%", width: "100%", minHeight: 0 }}>
      <ParticipantTile trackRef={ref} style={{ height: "100%" }} />
      {hand && ref.source !== Track.Source.ScreenShare && <span className="mt-tile-hand">✋</span>}
      {spotlight && spotlight === ref.participant.identity && ref.source !== Track.Source.ScreenShare && <span className="mt-tile-spot"><Star size={11} /> Spotlight</span>}
    </div>
  );
}

type Floater = { id: number; emoji: string; who: string; left: number };
type Toast = { id: string; kind: "lobby" | "info" | "breakout"; text: string; pid?: string; n?: number };
type CaptionLine = { name: string; text: string; at: number; final: boolean; tr?: string };

function Inner({ info, join, guest, leaving, onLeave, onSwitch, choices, secret }: {
  info: MeetingInfo; join: Admitted; guest: string | null; leaving: React.MutableRefObject<boolean>;
  onLeave: (why: LeaveWhy) => void; onSwitch: (j: Admitted) => void; choices: Choices; secret: string | null;
}) {
  const room = useRoomContext();
  const roomNo = join.room ?? 0;
  const owner = join.role === "host";
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const speaking = useSpeakingParticipants();
  const roomInfo = useRoomInfo();
  const recordingFlag = useIsRecording();
  const layoutCtx = useLayoutContext();
  const pinned = usePinnedTracks();
  const meta = useMemo<RoomMeta>(() => {
    try {
      return JSON.parse(roomInfo.metadata || "{}");
    } catch {
      return {};
    }
  }, [roomInfo.metadata]);
  // Breakout rooms have no metadata of their own: keep what the main room said.
  const lastMeta = useRef<RoomMeta>({});
  if (!roomNo && roomInfo.metadata) lastMeta.current = meta;
  const m = roomNo ? lastMeta.current : meta;
  const [promoted, setPromoted] = useState(join.role === "cohost");
  const hostLike = owner || promoted || !!m.coHosts?.includes(localParticipant.identity);
  // Webinars: attendees can't publish (LiveKit permissions; a host can bring them on stage).
  const perms = useLocalParticipantPermissions();
  const webinar = (m.kind ?? info.kind) === "webinar";
  const attendee = webinar && !hostLike && (perms ? !perms.canPublish : join.role === "attendee");
  const live = !roomNo && !!meta.live;
  const recording = !roomNo && (!!meta.recording || (recordingFlag && !meta.notes));
  const notesOn = !roomNo && !!meta.notes;

  const allTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // Attendees aren't on screen (not even to themselves).
  const tracks = attendee ? allTracks.filter((t) => !t.participant.isLocal) : allTracks;
  const screen = tracks.find((t) => isTrackReference(t) && t.source === Track.Source.ScreenShare);
  const spot = m.spotlight ? tracks.find((t) => t.source === Track.Source.Camera && t.participant.identity === m.spotlight) : undefined;
  const [layout, setLayout] = useState<"grid" | "speaker">("grid");
  const focus = useMemo(() => {
    if (spot) return spot;
    if (pinned[0]) return pinned[0];
    if (screen) return screen;
    const cams = tracks.filter((t) => t.source === Track.Source.Camera);
    const sp = speaking.find((p) => !p.isLocal);
    return cams.find((t) => sp && t.participant.identity === sp.identity) ?? cams.find((t) => !t.participant.isLocal) ?? cams[0];
  }, [spot, pinned, screen, tracks, speaking]);
  const effective = spot || pinned.length || screen ? "speaker" : layout;

  const [panel, setPanel] = useState<Panel>("");
  const [menu, setMenu] = useState<"" | "more" | "react" | "leave">("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [hand, setHand] = useState(false);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [busy, setBusy] = useState("");
  const [board, setBoard] = useState(false);
  const [chatTo, setChatTo] = useState("");
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((t: Omit<Toast, "id"> & { id?: string }, ms = 5000) => {
    const id = t.id ?? String(Math.random());
    setToasts((x) => [...x.filter((y) => y.id !== id), { ...t, id }]);
    if (ms) setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), ms);
  }, []);
  const say = useCallback((text: string) => toast({ kind: "info", text }), [toast]);

  // Everyone is told when recording, AI notes or captions start.
  const prevRec = useRef({ recording: false, notes: false, captions: false });
  useEffect(() => {
    if (recording && !prevRec.current.recording) toast({ id: "rec", kind: "info", text: "🔴 This meeting is now being recorded." }, 6000);
    if (notesOn && !prevRec.current.notes) toast({ id: "notes", kind: "info", text: "📝 AI notes are on: the meeting audio is being recorded for notes." }, 6000);
    if (m.captions && !prevRec.current.captions) toast({ id: "cc", kind: "info", text: "💬 Live captions are on: what people say is shown as text and saved to the meeting transcript." }, 7000);
    prevRec.current = { recording, notes: notesOn, captions: !!m.captions };
  }, [recording, notesOn, m.captions, toast]);

  // Host hand-over and co-host changes.
  const [audBump, setAudBump] = useState(0);
  useDataChannel("iotx.webinar", (msg) => {
    const d = parse(msg.payload);
    const me = d.identity === localParticipant.identity;
    if (d.type === "stage" && me) {
      setHand(false);
      say("You're on stage. Turn on your microphone or camera when you're ready.");
    } else if (d.type === "audience" && me) say("You're back in the audience.");
    else if (d.type === "hand" && hostLike) {
      setAudBump((x) => x + 1);
      if (panel !== "webinar") say("✋ Someone in the audience raised their hand. See Webinar → Audience.");
    } else if (hostLike) setAudBump((x) => x + 1);
  });
  useDataChannel("iotx.host", (msg) => {
    const d = parse(msg.payload);
    const me = d.identity === localParticipant.identity;
    if (d.type === "handover") {
      if (me) setPromoted(true);
      say(me ? "The host left. You now have host controls." : `${d.name} now has host controls.`);
    } else if (d.type === "cohost") {
      if (me) setPromoted(true);
      say(me ? "You're now a co-host." : `${d.name} is now a co-host.`);
    } else if (d.type === "cohost_off" && me) {
      setPromoted(false);
      say("You're no longer a co-host.");
    }
  });

  // Reactions (data messages).
  const addFloater = useCallback((emoji: string, who: string) => {
    const f = { id: Date.now() + Math.random(), emoji, who, left: 8 + Math.random() * 70 };
    setFloaters((x) => [...x.slice(-20), f]);
    setTimeout(() => setFloaters((x) => x.filter((y) => y.id !== f.id)), 3300);
  }, []);
  const { send: sendReaction } = useDataChannel("iotx.react", (msg) => {
    const d = parse(msg.payload) as { emoji?: string };
    if (d.emoji && EMOJIS.includes(d.emoji)) addFloater(d.emoji, msg.from?.name || "Someone");
  });
  const react = async (emoji: string) => {
    setMenu("");
    addFloater(emoji, "You");
    await sendReaction(enc.encode(JSON.stringify({ emoji })), { reliable: true }).catch(() => {});
  };

  const ctx: Ctx = { code: info.code, guest, identity: localParticipant.identity, hostLike, room: roomNo, participants, toast: say };
  const chat = useMeetChat(ctx, panel === "chat");

  // ── Captions
  const [ccView, setCcView] = useState(store.get("iotx-meet-cc") !== "off");
  const [trLang, setTrLang] = useState(store.get("iotx-meet-tr") ?? "");
  const [lines, setLines] = useState<Record<string, CaptionLine>>({});
  const trRef = useRef(trLang);
  trRef.current = trLang;
  const translateLine = useCallback(async (key: string, text: string) => {
    if (!trRef.current) return;
    try {
      const r = await meetApi<{ lines: string[] }>(`/${info.code}/translate`, { body: { lines: [text], lang: trRef.current }, guest });
      setLines((x) => (x[key]?.text === text ? { ...x, [key]: { ...x[key], tr: r.lines[0] } } : x));
    } catch {}
  }, [info.code, guest]);
  const showLine = useCallback((key: string, name: string, text: string, final: boolean) => {
    setLines((x) => ({ ...x, [key]: { name, text, at: Date.now(), final } }));
    if (final) void translateLine(key, text);
  }, [translateLine]);
  const { send: sendCaption } = useDataChannel("iotx.caption", (msg) => {
    const d = parse(msg.payload);
    if (typeof d.text === "string" && msg.from) showLine(msg.from.identity, msg.from.name || "Someone", d.text.slice(0, 500), !!d.final);
  });
  const sendCap = useRef(sendCaption);
  sendCap.current = sendCaption;
  const capSend = useCallback((text: string, final: boolean) => {
    showLine(localParticipant.identity, "You", text, final);
    void sendCap.current(enc.encode(JSON.stringify({ text, final })), { reliable: final }).catch(() => {});
    if (final) void meetApi(`/${info.code}/captions`, { body: { text }, guest }).catch(() => {});
  }, [showLine, localParticipant.identity, info.code, guest]);
  const capErr = useCaptionSender(!!m.captions, m.captionLang ?? "en-US", isMicrophoneEnabled, capSend);
  const micTrack = isMicrophoneEnabled ? localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack : undefined;
  const serverCcErr = useServerCaptions(
    !!m.captions && !secret && !speechSupported() && !attendee,
    micTrack,
    async (blob) => {
      const fd = new FormData();
      fd.append("file", blob, "chunk");
      const r = await fetch(`/workspace/api/meet/${info.code}/transcribe`, { method: "POST", body: fd, headers: guest ? { "x-meet-guest": guest } : {} });
      const d = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!r.ok) throw new Error(d.error || "Captions aren't working right now.");
      return d.text ?? "";
    },
    (text) => {
      // Already saved by the server: show it and tell the room.
      showLine(localParticipant.identity, "You", text, true);
      void sendCap.current(enc.encode(JSON.stringify({ text, final: true })), { reliable: true }).catch(() => {});
    },
  );
  useEffect(() => {
    if (serverCcErr) say(serverCcErr);
  }, [serverCcErr, say]);
  useEffect(() => {
    if (capErr) say(capErr);
  }, [capErr, say]);
  const visibleLines = Object.entries(lines).filter(([, l]) => now - l.at < (l.final ? 7000 : 4000)).sort((a, b) => a[1].at - b[1].at).slice(-3);

  // ── Background effects, noise suppression
  const bg = useBackground(localParticipant, isCameraEnabled);
  type Ns = "standard" | "strong" | "ai";
  const [ns, setNs] = useState<Ns>(() => (["strong", "ai"].includes(store.get("iotx-meet-ns") ?? "") ? (store.get("iotx-meet-ns") as Ns) : "standard"));
  const micPub = localParticipant.getTrackPublication(Track.Source.Microphone);
  const micLocal = micPub?.track as LocalAudioTrack | undefined;
  // The AI model runs as a LiveKit audio processor on my microphone track (re-applied when the track changes).
  useEffect(() => {
    if (!micLocal) return;
    const want = ns === "ai" && aiNoiseSupported();
    const has = micLocal.getProcessor()?.name === "iotx-rnnoise";
    if (want && !has) micLocal.setProcessor(rnnoiseProcessor()).catch((e) => { say(`The AI noise filter couldn't start: ${(e as Error).message}`); });
    if (!want && has) void micLocal.stopProcessor().catch(() => {});
  }, [ns, micLocal, say]);
  const setNoise = async (next: Ns) => {
    setNs(next);
    store.set("iotx-meet-ns", next);
    const t = localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    await t?.restartTrack({ deviceId: choices.audioDeviceId, echoCancellation: true, noiseSuppression: next !== "ai", autoGainControl: true, ...(next === "strong" ? { voiceIsolation: true } : {}) } as MediaTrackConstraints).catch(() => {});
    say(next === "ai" ? "Strong (AI) noise suppression on: a noise-removal model runs on this device." : next === "strong" ? "Strong noise suppression on (voice isolation where your browser supports it)." : "Standard noise suppression.");
  };


  // ── Host: settings, waiting room
  const loadHost = useCallback(async () => {
    if (!hostLike || roomNo) return;
    try {
      const d = await meetApi<{ meeting: HostInfo }>(`/${info.code}`, { guest });
      setHostInfo((d.meeting as HostInfo).settings ? d.meeting : null);
    } catch {}
  }, [hostLike, roomNo, info.code, guest]);
  const knownWaiting = useRef(new Set<string>());
  const loadLobby = useCallback(async () => {
    if (!hostLike) return;
    try {
      const d = await meetApi<{ waiting: Waiting[] }>(`/${info.code}/lobby`, { guest });
      setWaiting(d.waiting);
      for (const w of d.waiting)
        if (!knownWaiting.current.has(w.id)) {
          knownWaiting.current.add(w.id);
          toast({ id: `lobby-${w.id}`, kind: "lobby", text: `${w.name} wants to join`, pid: w.id }, 0);
        }
      const ids = new Set(d.waiting.map((w) => w.id));
      setToasts((x) => x.filter((t) => t.kind !== "lobby" || ids.has(t.pid!)));
    } catch {}
  }, [hostLike, info.code, guest, toast]);
  useEffect(() => {
    if (!hostLike) return;
    loadHost();
    loadLobby();
    const t = setInterval(loadLobby, 4000);
    return () => clearInterval(t);
  }, [hostLike, loadHost, loadLobby]);
  useDataChannel("iotx.lobby", () => loadLobby());

  const decide = async (participantId: string | null, action: "admit" | "deny") => {
    try {
      await meetApi(`/${info.code}/lobby`, { body: participantId ? { participantId, action } : { all: true, action }, guest });
    } catch (e) {
      say((e as Error).message);
    }
    loadLobby();
  };
  const hostAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMenu("");
    try {
      await fn();
    } catch (e) {
      toast({ kind: "info", text: (e as Error).message }, 7000);
    } finally {
      setBusy("");
      loadHost();
    }
  };
  const control = (action: string, extra: Record<string, unknown> = {}) => meetApi(`/${info.code}/control`, { body: { action, ...extra }, guest });
  const record = (kind: "video" | "audio", action: "start" | "stop") => meetApi(`/${info.code}/record`, { body: { kind, action }, guest });
  const settings = (patch: Record<string, unknown>) => meetApi(`/${info.code}`, { method: "PATCH", body: patch, guest });

  // ── Polls and Q&A badges
  const [pollBadge, setPollBadge] = useState(0);
  const [qaBadge, setQaBadge] = useState(0);
  useDataChannel("iotx.poll", (msg) => {
    const d = parse(msg.payload);
    if (d.type === "open" && panel !== "polls") {
      setPollBadge((x) => x + 1);
      say(`📊 New poll: ${d.question}`);
    }
  });
  useDataChannel("iotx.qa", (msg) => {
    if (parse(msg.payload).type === "ask" && panel !== "qa" && hostLike) setQaBadge((x) => x + 1);
  });
  useEffect(() => {
    if (panel === "polls") setPollBadge(0);
    if (panel === "qa") setQaBadge(0);
  }, [panel]);

  // ── Breakout rooms
  const [bo, setBo] = useState<BoState | null>(null);
  const loadBo = useCallback(() => meetApi<BoState>(`/${info.code}/breakout`, { guest }).then((d) => { setBo(d); return d; }).catch(() => null), [info.code, guest]);
  useEffect(() => { loadBo(); }, [loadBo]);
  const switchTo = useCallback(async (n: number) => {
    try {
      const r = await meetApi<{ token: string; url: string; room: number; name?: string; role: Admitted["role"] }>(`/${info.code}/breakout`, { body: { action: "token", n }, guest });
      leaving.current = true;
      await room.disconnect();
      onSwitch({ ...join, token: r.token, url: r.url, room: r.room, roomName: r.name, role: r.role });
    } catch (e) {
      say((e as Error).message);
    }
  }, [info.code, guest, room, join, onSwitch, leaving, say]);
  useDataChannel("iotx.breakout", async (msg) => {
    const d = parse(msg.payload);
    if (d.type === "message") return toast({ kind: "info", text: `📣 ${d.from}: ${d.text}` }, 10000);
    if (d.type === "close" && roomNo) {
      toast({ kind: "info", text: "Breakout rooms are closing. Returning to the main room…" }, 4000);
      setTimeout(() => switchTo(0), 2500);
      return;
    }
    const s = await loadBo();
    if (!s?.breakout?.open) return;
    if ((d.type === "open" || d.type === "moved") && s.mine && s.mine !== roomNo) {
      const r = s.breakout.rooms.find((x) => x.n === s.mine);
      toast({ id: "bo", kind: "breakout", text: `You've been assigned to ${r?.name ?? `Room ${s.mine}`}.`, n: s.mine }, 0);
    } else if (d.type === "open" && s.breakout.allowChoose && !roomNo) {
      toast({ id: "bo", kind: "info", text: "Breakout rooms are open. Pick one in Breakout rooms." }, 8000);
    }
  });

  // ── Leaving
  const toggleHand = async () => {
    const up = !hand;
    setHand(up);
    try {
      await meetApi(`/${info.code}/hand`, { body: { up }, guest });
    } catch {
      setHand(!up);
    }
  };
  const leave = async (end = false, transferTo?: string) => {
    leaving.current = true;
    if (end) await control("end").catch(() => {});
    else await meetApi(`/${info.code}/leave`, { body: { transferTo }, guest }).catch(() => {});
    await room.disconnect();
    onLeave(end ? "ended" : "left");
  };

  const inviteLink = `${typeof location !== "undefined" ? location.origin : ""}/workspace/meet/${info.code}${hostInfo?.settings.passcode ? `?p=${hostInfo.settings.passcode}` : ""}${secret ? `#k=${secret}` : ""}`;
  const dialIn = hostInfo?.dialIn ?? join.dialIn ?? null;
  const invitation = inviteText(m.title ?? info.title, inviteLink, hostInfo?.settings.passcode ?? null, dialIn);
  const copyLink = async () => {
    setMenu("");
    try {
      await navigator.clipboard.writeText(inviteLink);
      say(hostInfo?.settings.passcode ? "Meeting link (with passcode) copied." : "Meeting link copied.");
    } catch {
      toast({ kind: "info", text: inviteLink }, 8000);
    }
  };
  const pip = async () => {
    setMenu("");
    if (document.pictureInPictureElement) return void document.exitPictureInPicture().catch(() => {});
    const vids = [...document.querySelectorAll<HTMLVideoElement>(".mt-stage video")].filter((v) => v.readyState >= 2);
    const v = vids.find((x) => !x.closest("[data-lk-local-participant='true']")) ?? vids[0];
    if (!v || !document.pictureInPictureEnabled) return say("Picture-in-picture needs someone's video and a browser that supports it.");
    await v.requestPictureInPicture().catch(() => say("Your browser blocked picture-in-picture."));
  };
  const pinTo = (p: Participant) => {
    const t = tracks.find((x) => x.participant.identity === p.identity && x.source === Track.Source.Camera);
    if (!t || !layoutCtx.pin.dispatch) return;
    const isPinned = pinned.some((x) => x.participant.identity === p.identity);
    layoutCtx.pin.dispatch(isPinned ? { msg: "clear_pin" } : { msg: "set_pin", trackReference: t });
  };

  // ── Keyboard shortcuts (Zoom's): Alt+A mic, Alt+V camera, Alt+S share, Alt+Y hand, Alt+H chat, Alt+U people, Alt+C captions, ? help.
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      const k = e.key.toLowerCase();
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const act: Record<string, () => void> = {
          a: () => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {}),
          v: () => void localParticipant.setCameraEnabled(!isCameraEnabled).catch(() => {}),
          s: () => canShare && void localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true }).catch(() => {}),
          y: () => void toggleHand(),
          h: () => setPanel((p) => (p === "chat" ? "" : "chat")),
          u: () => setPanel((p) => (p === "people" ? "" : "people")),
          c: () => setCcView((x) => { store.set("iotx-meet-cc", x ? "off" : "on"); return !x; }),
          m: () => hostLike && void hostAction("mute_all", () => control("mute_all")),
        };
        const f = act[e.code.replace(/^Key/, "").toLowerCase()] ?? act[k];
        if (f) {
          e.preventDefault();
          f();
        }
      } else if (e.key === "?") setPanel((p) => (p === "keys" ? "" : "keys"));
      else if (e.key === "Escape") setMenu("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const locked = hostInfo?.settings.locked ?? m.locked ?? false;
  const hands = participants.filter((p) => p.attributes?.hand).length;
  const roleLabel = (p: Participant) => {
    const r = roleOf(p);
    if (p.identity === m.host || r === "host") return "Host";
    if (m.coHosts?.includes(p.identity) || r === "cohost") return "Co-host";
    return r === "guest" ? "Guest" : "Member";
  };
  const panelTitle: Record<Exclude<Panel, "">, string> = {
    webinar: "Webinar", live: "Live stream", info: webinar ? "Webinar information" : "Meeting information",
    chat: "In-meeting chat", people: `People (${participants.length})`, polls: "Polls", qa: "Q&A", breakout: "Breakout rooms", effects: "Backgrounds and effects", host: "Host settings", keys: "Keyboard shortcuts",
  };
  const open = (p: Panel) => {
    setMenu("");
    setPanel(panel === p ? "" : p);
  };

  return (
    <>
      <header className="mt-topbar">
        <span className="mt-mark" aria-hidden>IX</span>
        <h1 title={info.title}>{m.title ?? info.title}{roomNo ? ` · ${join.roomName ?? `Room ${roomNo}`}` : ""}</h1>
        <span className="mt-pill mt-hide-sm">{info.code}</span>
        {secret && <span className="mt-pill e2ee" role="status" title="End-to-end encrypted: audio, video and screen sharing can only be decoded by people with the key. Recording, captions, AI notes, streaming and dial-in are off."><ShieldCheck size={12} /> Encrypted</span>}
        {recording && <span className="mt-pill rec" role="status">Recording</span>}
        {live && <span className="mt-pill rec" role="status" title="This meeting is being streamed live"><Radio size={12} /> Live</span>}
        {webinar && <span className="mt-pill mt-hide-sm">{attendee ? "Attendee · view only" : hostLike ? "Webinar host" : "Panelist"}</span>}
        {notesOn && <span className="mt-pill rec" role="status">AI notes on</span>}
        {m.captions && <span className="mt-pill mt-hide-sm" role="status"><Captions size={12} /> Captions</span>}
        {locked && !roomNo && <span className="mt-pill" title="Locked: nobody new can join"><Lock size={12} /> Locked</span>}
        {hostLike && !owner && <span className="mt-pill mt-hide-sm"><ShieldCheck size={12} /> Co-host</span>}
        <span style={{ flex: 1 }} />
        {roomNo > 0 && <button className="mt-btn sm" onClick={() => switchTo(0)}>Return to main room</button>}
        <span className="mt-pill mt-hide-sm">{clock}</span>
        <span title="Your connection" style={{ display: "inline-flex" }}><ConnectionQualityIndicator participant={localParticipant} /></span>
      </header>

      <div className="mt-room-body">
        <div className="mt-stage">
          {board ? (
            <Whiteboard ctx={ctx} onClose={() => setBoard(false)} canDraw={!attendee} title={m.title ?? info.title} />
          ) : effective === "grid" ? (
            <GridLayout tracks={tracks} style={{ height: "100%" }}>
              <Tile spotlight={m.spotlight} />
            </GridLayout>
          ) : (
            <FocusLayoutContainer style={{ height: "100%" }}>
              <CarouselLayout tracks={tracks.filter((t) => t !== focus)}>
                <Tile spotlight={m.spotlight} />
              </CarouselLayout>
              {focus && <FocusLayout trackRef={focus} />}
            </FocusLayoutContainer>
          )}
          <div className="mt-floaters" aria-hidden>
            {floaters.map((f) => (
              <span key={f.id} className="mt-floater" style={{ left: `${f.left}%` }}>
                {f.emoji}
                <small>{f.who}</small>
              </span>
            ))}
          </div>
          {m.captions && ccView && visibleLines.length > 0 && (
            <div className="mt-captions" aria-live="polite">
              {visibleLines.map(([k, l]) => (
                <div key={k}><b>{l.name}:</b> {l.tr ?? l.text}</div>
              ))}
            </div>
          )}
        </div>

        {panel && (
          <aside className="mt-side" aria-label={panelTitle[panel]}>
            <div className="mt-side-head">
              <b>{panelTitle[panel]}</b>
              <button className="mt-iconbtn" onClick={() => setPanel("")} aria-label="Close"><X size={18} /></button>
            </div>
            {panel === "chat" && <ChatPanel ctx={ctx} chat={chat} to={chatTo} setTo={setChatTo} />}
            {panel === "polls" && <PollsPanel ctx={ctx} />}
            {panel === "qa" && <QAPanel ctx={ctx} />}
            {panel === "breakout" && <BreakoutPanel ctx={ctx} state={bo} reload={loadBo} onJoin={switchTo} />}
            {panel === "webinar" && hostLike && <WebinarPanel ctx={ctx} bump={audBump} settings={hostInfo?.settings ?? null} onSettings={(p) => hostAction("web", () => settings(p))} />}
            {panel === "live" && <StreamPanel ctx={ctx} canStream={!!hostInfo?.can.record} />}
            {panel === "info" && <InfoPanel ctx={ctx} link={inviteLink} passcode={hostLike ? hostInfo?.settings.passcode ?? null : null} dialIn={dialIn} encrypted={!!secret} invite={invitation} />}
            {panel === "keys" && (
              <div className="mt-side-body">
                <table className="mt-keys"><tbody>
                  {[["Alt + A", "Mute / unmute"], ["Alt + V", "Camera on / off"], ["Alt + S", "Share screen"], ["Alt + Y", "Raise / lower hand"], ["Alt + H", "Chat"], ["Alt + U", "People"], ["Alt + C", "Show / hide captions"], ["Alt + M", "Mute everyone (hosts)"], ["?", "This list"], ["Esc", "Close menus"]].map(([k, d]) => (
                    <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
            {panel === "effects" && (
              <div className="mt-side-body">
                {!bg.supported ? <p className="mt-note">Background effects aren&apos;t supported in this browser.</p> : (
                  <>
                    {!isCameraEnabled && <p className="mt-note">Turn your camera on to see the effect.</p>}
                    <div className="mt-bggrid">
                      <button className={`mt-bg${bg.bg.mode === "none" ? " on" : ""}`} onClick={() => bg.setBg({ mode: "none" })}>None</button>
                      <button className={`mt-bg${bg.bg.mode === "blur" && bg.bg.radius < 15 ? " on" : ""}`} onClick={() => bg.setBg({ mode: "blur", radius: 8 })}>Slight blur</button>
                      <button className={`mt-bg${bg.bg.mode === "blur" && bg.bg.radius >= 15 ? " on" : ""}`} onClick={() => bg.setBg({ mode: "blur", radius: 20 })}>Blur</button>
                      {presetBackgrounds().map((p) => (
                        <button key={p.label} className={`mt-bg img${bg.bg.mode === "image" && bg.bg.label === p.label ? " on" : ""}`} style={{ backgroundImage: `url(${p.src})` }} onClick={() => bg.setBg({ mode: "image", src: p.src, label: p.label })}>{p.label}</button>
                      ))}
                      <label className="mt-bg">Your image
                        <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) bg.setBg({ mode: "image", src: URL.createObjectURL(f), label: f.name }); }} />
                      </label>
                    </div>
                    {bg.error && <p className="mt-error">{bg.error}</p>}
                  </>
                )}
                <div className="mt-sect">Microphone</div>
                <select className="mt-select" value={ns} onChange={(e) => setNoise(e.target.value as Ns)} aria-label="Noise suppression">
                  <option value="standard">Standard noise suppression</option>
                  <option value="strong">Strong (voice isolation in the browser)</option>
                  {aiNoiseSupported() && <option value="ai">Strong (AI): noise-removal model on this device</option>}
                </select>
                <div className="mt-sect">Devices</div>
                <div className="mt-devices">
                  <MediaDeviceMenu kind="audioinput" className="mt-btn sm">Microphone</MediaDeviceMenu>
                  <MediaDeviceMenu kind="videoinput" className="mt-btn sm">Camera</MediaDeviceMenu>
                  <MediaDeviceMenu kind="audiooutput" className="mt-btn sm">Speaker</MediaDeviceMenu>
                </div>
              </div>
            )}
            {panel === "host" && hostInfo && (
              <div className="mt-side-body">
                <label className="mt-check"><input type="checkbox" checked={hostInfo.settings.waitingRoom} onChange={(e) => hostAction("wr", () => settings({ waitingRoom: e.target.checked }))} /> Guests wait in the waiting room</label>
                <label className="mt-check"><input type="checkbox" checked={hostInfo.settings.everyoneWaits} onChange={(e) => hostAction("ew", () => settings({ everyoneWaits: e.target.checked }))} /> Members wait too</label>
                {hostInfo.can.guests && <label className="mt-check"><input type="checkbox" checked={hostInfo.settings.allowGuests} onChange={(e) => hostAction("guests", () => settings({ allowGuests: e.target.checked }))} /> Allow guests with the link</label>}
                <label className="mt-check"><input type="checkbox" checked={hostInfo.settings.muteOnEntry} onChange={(e) => hostAction("moe", () => settings({ muteOnEntry: e.target.checked }))} /> Mute people when they join</label>
                <div className="mt-sect">Passcode for guests</div>
                <Passcode value={hostInfo.settings.passcode} onSave={(v) => hostAction("pc", () => settings({ passcode: v }))} />
                <div className="mt-sect">Live captions</div>
                <label className="mt-check"><input type="checkbox" checked={!!m.captions} onChange={(e) => hostAction("cc", () => control("captions", { on: e.target.checked }))} /> Captions on for everyone</label>
                <select className="mt-select" value={m.captionLang ?? "en-US"} onChange={(e) => hostAction("cc", () => control("captions", { on: !!m.captions, lang: e.target.value }))} aria-label="Spoken language">
                  {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {!speechSupported() && <p className="mt-note">Browsers without speech recognition (Firefox, some Safari) send short audio clips to the server for captions instead.</p>}
              </div>
            )}
            {panel === "people" && (
              <div className="mt-side-body">
                {hostLike && waiting.length > 0 && (
                  <div className="mt-wait">
                    <div className="mt-sect" style={{ marginTop: 0 }}>
                      Waiting to join ({waiting.length})
                      <span style={{ flex: 1 }} />
                      <button className="mt-btn sm" onClick={() => decide(null, "admit")}>Admit all</button>
                    </div>
                    {waiting.map((w) => (
                      <div key={w.id} className="mt-person">
                        <span className="mt-avatar" style={{ background: colorFor(w.id) }}>{initials(w.name)}</span>
                        <div className="who"><b>{w.name}</b><span>{w.kind === "member" ? "Member" : "Guest"}</span></div>
                        <button className="mt-btn sm primary" onClick={() => decide(w.id, "admit")}>Admit</button>
                        <button className="mt-btn sm" onClick={() => decide(w.id, "deny")}>Deny</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-sect">In the {roomNo ? "room" : "meeting"}</div>
                {participants.map((p) => (
                  <Person key={p.identity} p={p} role={roleLabel(p)} hostLike={hostLike && !roomNo} owner={owner} isCo={!!m.coHosts?.includes(p.identity)} spot={m.spotlight === p.identity}
                    pinned={pinned.some((x) => x.participant.identity === p.identity)}
                    onPin={() => pinTo(p)}
                    onMessage={() => { setChatTo(p.identity); setPanel("chat"); }}
                    onMute={() => hostAction("mute", () => control("mute", { identity: p.identity }))}
                    onSpot={() => hostAction("spot", () => control("spotlight", { identity: m.spotlight === p.identity ? "" : p.identity }))}
                    onCo={() => hostAction("co", () => control("cohost", { identity: p.identity, on: !m.coHosts?.includes(p.identity) }))}
                    onRemove={() => confirm(`Remove ${p.name || "this person"} from the meeting? They won't be able to rejoin.`) && hostAction("remove", () => control("remove", { identity: p.identity }))} />
                ))}
              </div>
            )}
          </aside>
        )}
      </div>

      <div className="mt-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="mt-toast">
            <span>{t.text}</span>
            {t.kind === "lobby" && (
              <div className="row">
                <button className="mt-btn sm primary" onClick={() => decide(t.pid!, "admit")}>Admit</button>
                <button className="mt-btn sm" onClick={() => decide(t.pid!, "deny")}>Deny</button>
                <button className="mt-btn sm" onClick={() => setPanel("people")}>See all</button>
              </div>
            )}
            {t.kind === "breakout" && (
              <div className="row">
                <button className="mt-btn sm primary" onClick={() => { setToasts((x) => x.filter((y) => y.id !== t.id)); switchTo(t.n!); }}>Join</button>
                <button className="mt-btn sm" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>Later</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <footer className="mt-controls" style={{ position: "relative" }}>
        <span className="grow mt-note mt-hide-sm">{participants.length} in the {roomNo ? "room" : "meeting"}</span>
        {!attendee && <><span className="mt-split">
          <button className={`mt-cbtn${isMicrophoneEnabled ? "" : " off"}`} onClick={() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch((e) => say(e.message))} aria-label={isMicrophoneEnabled ? "Mute" : "Unmute"} title={`${isMicrophoneEnabled ? "Mute" : "Unmute"} (Alt+A)`}>
            {isMicrophoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}
          </button>
          <span className="mt-hide-sm"><MediaDeviceMenu kind="audioinput" className="mt-mini" title="Microphone settings"><ChevronUp size={16} /></MediaDeviceMenu></span>
        </span>
        <span className="mt-split">
          <button className={`mt-cbtn${isCameraEnabled ? "" : " off"}`} onClick={() => localParticipant.setCameraEnabled(!isCameraEnabled).catch((e) => say(e.message))} aria-label={isCameraEnabled ? "Turn camera off" : "Turn camera on"} title="Camera (Alt+V)">
            {isCameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}
          </button>
          <span className="mt-hide-sm"><MediaDeviceMenu kind="videoinput" className="mt-mini" title="Camera settings"><ChevronUp size={16} /></MediaDeviceMenu></span>
        </span>
        {canShare && (
          <button className={`mt-cbtn mt-hide-sm${isScreenShareEnabled ? " on" : ""}`} onClick={() => localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true }).catch(() => {})} aria-label={isScreenShareEnabled ? "Stop sharing" : "Share screen"} title="Share screen (Alt+S)">
            <MonitorUp size={20} />
          </button>
        )}
        </>}
        <button className={`mt-cbtn mt-hide-sm${hand ? " on" : ""}`} onClick={toggleHand} aria-label={hand ? "Lower hand" : "Raise hand"} title="Raise hand (Alt+Y)"><Hand size={20} /></button>
        <button className={`mt-cbtn mt-hide-sm${menu === "react" ? " on" : ""}`} onClick={() => setMenu(menu === "react" ? "" : "react")} aria-label="Reactions" title="Reactions" aria-expanded={menu === "react"}><Smile size={20} /></button>
        {m.captions && (
          <button className={`mt-cbtn mt-hide-sm${ccView ? " on" : ""}`} onClick={() => setCcView((x) => { store.set("iotx-meet-cc", x ? "off" : "on"); return !x; })} aria-label={ccView ? "Hide captions" : "Show captions"} title="Captions (Alt+C)"><Captions size={20} /></button>
        )}
        <button className={`mt-cbtn${panel === "chat" ? " on" : ""}`} onClick={() => open("chat")} aria-label="Chat" title="Chat (Alt+H)">
          <MessageSquare size={20} />
          {chat.unread > 0 && <span className="mt-cbtn-badge">{chat.unread}</span>}
        </button>
        <button className={`mt-cbtn${panel === "people" ? " on" : ""}`} onClick={() => open("people")} aria-label="People" title="People (Alt+U)">
          <Users size={20} />
          {(waiting.length > 0 || hands > 0) && <span className="mt-cbtn-badge">{waiting.length || hands}</span>}
        </button>
        <button className={`mt-cbtn${menu === "more" ? " on" : ""}`} onClick={() => setMenu(menu === "more" ? "" : "more")} aria-label="More options" title="More" aria-expanded={menu === "more"}>
          <MoreVertical size={20} />
          {pollBadge + qaBadge > 0 && <span className="mt-cbtn-badge">{pollBadge + qaBadge}</span>}
        </button>
        <button className="mt-cbtn leave" onClick={() => (hostLike || roomNo ? setMenu(menu === "leave" ? "" : "leave") : leave())} aria-label="Leave the meeting" title="Leave"><PhoneOff size={20} /></button>
        <span className="grow mt-hide-sm" />

        {menu === "react" && (
          <div className="mt-menu" style={{ left: "50%", transform: "translateX(-50%)" }} role="menu">
            <div className="mt-emojis">
              {EMOJIS.map((e) => <button key={e} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}
            </div>
          </div>
        )}
        {menu === "leave" && (
          <div className="mt-menu" style={{ right: 16 }} role="menu">
            {roomNo > 0 && <button onClick={() => { setMenu(""); switchTo(0); }}><DoorOpen size={16} /> Return to the main room</button>}
            <button onClick={() => leave(false)}><PhoneOff size={16} /> Leave the meeting</button>
            {hostLike && !roomNo && participants.length > 1 && (
              <div className="mt-leave-to">
                <span className="hint">Leave and give host controls to</span>
                {participants.filter((p) => !p.isLocal).slice(0, 8).map((p) => <button key={p.identity} onClick={() => leave(false, p.identity)}>{p.name || "Guest"}</button>)}
              </div>
            )}
            {(owner || (hostLike && !guest)) && !roomNo && (
              <button onClick={() => confirm("End the meeting for everyone?") && leave(true)} style={{ color: "#ff8589" }}><X size={16} /> End meeting for all</button>
            )}
          </div>
        )}
        {menu === "more" && (
          <div className="mt-menu mt-more" style={{ right: 16 }} role="menu">
            <div className="mt-show-sm">
              {canShare && <button onClick={() => { setMenu(""); localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true }).catch(() => {}); }}><MonitorUp size={16} /> {isScreenShareEnabled ? "Stop sharing" : "Share screen"}</button>}
              <button onClick={() => { setMenu(""); toggleHand(); }}><Hand size={16} /> {hand ? "Lower hand" : "Raise hand"}</button>
              <div className="mt-emojis">{EMOJIS.slice(0, 6).map((e) => <button key={e} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}</div>
              {m.captions && <button onClick={() => { setMenu(""); setCcView(!ccView); }}><Captions size={16} /> {ccView ? "Hide captions" : "Show captions"}</button>}
              <div className="sep" />
            </div>
            <button onClick={() => open("polls")}><BarChart3 size={16} /> Polls{pollBadge ? ` (${pollBadge} new)` : ""}</button>
            <button onClick={() => open("qa")}><MessageCircleQuestion size={16} /> Q&amp;A{qaBadge ? ` (${qaBadge} new)` : ""}</button>
            {(hostLike || bo?.breakout) && <button onClick={() => open("breakout")}><Split size={16} /> Breakout rooms</button>}
            <button onClick={() => { setMenu(""); setBoard(!board); }}><PenLine size={16} /> {board ? "Back to video" : "Whiteboard"}</button>
            <div className="sep" />
            <button onClick={() => (setLayout(layout === "grid" ? "speaker" : "grid"), setMenu(""))} disabled={!!screen || !!spot}>
              {effective === "grid" ? <Presentation size={16} /> : <LayoutGrid size={16} />}
              {effective === "grid" ? "Speaker view" : "Grid view"}
            </button>
            {pinned.length > 0 && <button onClick={() => { setMenu(""); layoutCtx.pin.dispatch?.({ msg: "clear_pin" }); }}><Pin size={16} /> Unpin</button>}
            <button onClick={pip}><PictureInPicture2 size={16} /> Picture-in-picture</button>
            <button onClick={() => open("effects")}><Sparkles size={16} /> Backgrounds, noise and devices</button>
            {m.captions && (
              <label className="mt-menu-row">
                <Captions size={16} /> Translate captions
                <select className="mt-select" value={trLang} onChange={(e) => { setTrLang(e.target.value); store.set("iotx-meet-tr", e.target.value); }} aria-label="Translate captions to">
                  <option value="">Off</option>
                  {TRANSLATE.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
            )}
            <button onClick={copyLink}><Copy size={16} /> Copy invite link</button>
            <button onClick={() => open("info")}><Info size={16} /> {webinar ? "Webinar" : "Meeting"} information and dial-in</button>
            <button onClick={() => open("keys")}><Keyboard size={16} /> Keyboard shortcuts</button>
            {hostLike && !roomNo && (
              <>
                <div className="sep" />
                <div className="hint">Host controls</div>
                <button onClick={() => hostAction("mute_all", () => control("mute_all"))} disabled={!!busy}><VolumeX size={16} /> Mute everyone</button>
                <button onClick={() => hostAction("lock", () => control(locked ? "unlock" : "lock"))} disabled={!!busy}>
                  {locked ? <LockOpen size={16} /> : <Lock size={16} />} {locked ? "Unlock meeting" : "Lock meeting"}
                </button>
                {!secret && <button onClick={() => hostAction("cc", () => control("captions", { on: !m.captions }))} disabled={!!busy}><Captions size={16} /> {m.captions ? "Turn captions off" : "Turn on live captions"}</button>}
                {m.spotlight && <button onClick={() => hostAction("spot", () => control("spotlight", { identity: "" }))}><Star size={16} /> Remove spotlight</button>}
                <button onClick={() => open("host")}><Settings2 size={16} /> Host settings</button>
                {webinar && <button onClick={() => open("webinar")}><Megaphone size={16} /> Webinar: audience and registrations</button>}
                {!secret && <button onClick={() => open("live")}><Radio size={16} /> {live ? "Live stream (on)" : "Live stream"}</button>}
                {hostInfo && !secret && (
                  <>
                    <button onClick={() => hostAction("rec", () => record("video", recording ? "stop" : "start"))} disabled={!hostInfo.can.record || !!busy} title={hostInfo.can.record ? "" : "Your role can't record meetings"}>
                      {recording ? <Square size={16} /> : <Circle size={16} color="#e5484d" />} {recording ? "Stop recording" : busy === "rec" ? "Starting…" : "Record meeting"}
                    </button>
                    <button onClick={() => hostAction("rec", () => record("audio", notesOn ? "stop" : "start"))} disabled={!hostInfo.can.aiNotes || !!busy} title={hostInfo.can.aiNotes ? "" : "Your role can't use AI notes"}>
                      <NotebookPen size={16} /> {notesOn ? "Stop AI notes" : "Take AI notes"}
                    </button>
                    {(!hostInfo.can.record || !hostInfo.can.aiNotes) && <div className="hint">Recording and AI notes need a switch from your admin.</div>}
                  </>
                )}
              </>
            )}
            {!guest && <a href={`/workspace/meet/${info.code}/notes`} target="_blank" rel="noreferrer"><NotebookPen size={16} /> Notes, recordings and chat</a>}
          </div>
        )}
      </footer>
    </>
  );
}

function Passcode({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  return (
    <div className="row">
      <input className="mt-input" placeholder="None" value={v} maxLength={10} onChange={(e) => setV(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} aria-label="Passcode" />
      <button className="mt-btn sm" disabled={v === (value ?? "") || (v.length > 0 && v.length < 4)} onClick={() => onSave(v || null)}>Save</button>
      {value && <button className="mt-btn sm" onClick={() => onSave(null)}>Remove</button>}
    </div>
  );
}

function Person({ p, role, hostLike, owner, isCo, spot, pinned, onPin, onMessage, onMute, onSpot, onCo, onRemove }: {
  p: Participant; role: string; hostLike: boolean; owner: boolean; isCo: boolean; spot: boolean; pinned: boolean;
  onPin: () => void; onMessage: () => void; onMute: () => void; onSpot: () => void; onCo: () => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hostRow = role === "Host";
  return (
    <div className="mt-person">
      <span className="mt-avatar" style={{ background: colorFor(p.identity) }}>{initials(p.name || p.identity)}</span>
      <div className="who">
        <b>{p.name || "Guest"}{p.isLocal ? " (you)" : ""}</b>
        <span>{role}{spot ? " · Spotlight" : ""}{pinned ? " · Pinned" : ""}{p.attributes?.hand ? " · ✋ Hand raised" : ""}</span>
      </div>
      <ConnectionQualityIndicator participant={p} />
      {p.isMicrophoneEnabled ? <Mic size={15} /> : <MicOff size={15} color="#ff8589" />}
      <span style={{ position: "relative" }}>
        <button className="mt-iconbtn" onClick={() => setOpen(!open)} aria-label={`Options for ${p.name || "this person"}`} aria-expanded={open}><MoreVertical size={16} /></button>
        {open && (
          <div className="mt-menu mt-pmenu" role="menu" onClick={() => setOpen(false)}>
            <button onClick={onPin}><Pin size={15} /> {pinned ? "Unpin" : "Pin for me"}</button>
            {!p.isLocal && <button onClick={onMessage}><MessageSquare size={15} /> Message privately</button>}
            {hostLike && <button onClick={onSpot}><Star size={15} /> {spot ? "Remove spotlight" : "Spotlight for everyone"}</button>}
            {hostLike && !p.isLocal && p.isMicrophoneEnabled && <button onClick={onMute}><VolumeX size={15} /> Mute</button>}
            {owner && !p.isLocal && !hostRow && <button onClick={onCo}><ShieldCheck size={15} /> {isCo ? "Remove co-host" : "Make co-host"}</button>}
            {hostLike && !p.isLocal && !hostRow && (owner || !isCo) && <button onClick={onRemove} style={{ color: "#ff8589" }}><DoorOpen size={15} /> Remove</button>}
          </div>
        )}
      </span>
    </div>
  );
}
