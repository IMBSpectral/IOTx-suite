"use client";

import { useState } from "react";
import {
  Wand2,
  Box,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  Image as ImageIcon,
  Music,
  Play,
  Video,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Attachment } from "./types";
import ImageEditor from "./ImageEditor";

/** What kind of resource a file is, for its icon and label. */
export function categoryOf(a: { name: string; type: string }): { label: string; Icon: LucideIcon } {
  const ext = a.name.split(".").pop()?.toLowerCase() ?? "";
  if (a.type.startsWith("image/")) return { label: "Image", Icon: ImageIcon };
  if (a.type.startsWith("video/")) return { label: "Video", Icon: Video };
  if (a.type.startsWith("audio/")) return { label: "Audio", Icon: Music };
  if (/^(zip|tar|gz|tgz|rar|7z)$/.test(ext)) return { label: "Archive", Icon: FileArchive };
  if (/^(csv|xlsx?|ods|tsv|numbers)$/.test(ext)) return { label: "Spreadsheet", Icon: FileSpreadsheet };
  if (/^(ttf|otf|woff2?)$/.test(ext)) return { label: "Font", Icon: FileType };
  if (/^(glb|gltf|obj|fbx|stl|usdz)$/.test(ext)) return { label: "3D model", Icon: Box };
  if (/^(mmd|drawio|excalidraw|puml)$/.test(ext)) return { label: "Diagram", Icon: Workflow };
  if (/^(js|jsx|ts|tsx|json|css|html|py|go|rs|java|rb|php|sql|sh|ya?ml|toml)$/.test(ext)) return { label: "Code", Icon: FileCode };
  return { label: "Document", Icon: FileText };
}

function duration(s: number) {
  if (!Number.isFinite(s)) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** One attachment in a chat message: a thumbnail, a player, or a file card. */
export default function AttachmentView({ a, src }: { a: Attachment; src: string }) {
  const [length, setLength] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const [editing, setEditing] = useState(false);
  // Images in a project's chat can be edited with AI (the src names the project).
  const projectId = /\/api\/projects\/([\w-]+)\/uploads\//.exec(src)?.[1];
  const editable = !!projectId && /^image\/(png|jpeg|webp)$/.test(a.type);

  if (a.type.startsWith("image/") && a.type !== "image/svg+xml") {
    if (broken) {
      return (
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          title="An ad blocker may be hiding this image. Open it directly, or allow images from this site."
          className="flex h-14 w-36 items-center rounded-lg border px-2 text-[10px] leading-tight hover:underline"
          style={{ color: "var(--muted)" }}
        >
          An ad blocker may be hiding this image.
        </a>
      );
    }
    const thumb = (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={a.name} onError={() => setBroken(true)} className="h-14 w-14 rounded-lg border object-cover" />
    );
    if (!editable) return thumb;
    return (
      <>
        <button onClick={() => setEditing(true)} title="Edit this image with AI" aria-label={`Edit ${a.name}`} className="group relative block">
          {thumb}
          <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
            <Wand2 className="h-4 w-4 text-white" />
          </span>
        </button>
        {editing && <ImageEditor projectId={projectId!} attachment={a} src={src} onClose={() => setEditing(false)} />}
      </>
    );
  }
  if (a.type.startsWith("video/")) {
    return (
      <div className="relative w-64 overflow-hidden rounded-lg border bg-black">
        <video
          src={src}
          controls={playing}
          preload="metadata"
          onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
          className="aspect-video w-full"
          aria-label={a.name}
        />
        {!playing && (
          <button
            onClick={(e) => {
              setPlaying(true);
              void (e.currentTarget.previousElementSibling as HTMLVideoElement | null)?.play();
            }}
            className="absolute inset-0 grid place-items-center bg-black/20"
            aria-label={`Play video ${a.name}`}
          >
            <span className="grid h-10 w-10 place-items-center rounded-full bg-white/90">
              <Play className="ml-0.5 h-4 w-4 text-black" />
            </span>
          </button>
        )}
        {length !== null && !playing && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">{duration(length)}</span>
        )}
      </div>
    );
  }
  if (a.type.startsWith("audio/")) {
    return (
      <div className="w-64 rounded-lg border p-2" style={{ background: "var(--panel)" }}>
        <p className="mb-1 flex items-center gap-1 truncate text-[11px]">
          <Music className="h-3 w-3 shrink-0" /> {a.name}
        </p>
        <audio src={src} controls preload="metadata" className="h-8 w-full" aria-label={a.name} />
      </div>
    );
  }
  const { label, Icon } = categoryOf(a);
  return (
    <a href={src} className="flex max-w-56 items-center gap-2 rounded-lg border px-2.5 py-1.5" style={{ background: "var(--panel)" }}>
      <Icon className="h-4 w-4 shrink-0" style={{ color: "var(--muted)" }} />
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium">{a.name}</span>
        <span className="block text-[10px]" style={{ color: "var(--muted)" }}>
          {label} · {a.size >= 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`}
        </span>
      </span>
    </a>
  );
}
