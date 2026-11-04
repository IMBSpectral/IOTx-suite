import { Braces, Database, File, FileCode2, FileImage, FileText, Hash, Settings2 } from "lucide-react";

type Kind = { Icon: typeof File; color: string; label: string };

const BY_EXT: Record<string, Kind> = {
  tsx: { Icon: FileCode2, color: "#3178c6", label: "TypeScript React" },
  ts: { Icon: FileCode2, color: "#3178c6", label: "TypeScript" },
  mts: { Icon: FileCode2, color: "#3178c6", label: "TypeScript" },
  jsx: { Icon: FileCode2, color: "#d4a20b", label: "JavaScript React" },
  js: { Icon: FileCode2, color: "#d4a20b", label: "JavaScript" },
  mjs: { Icon: FileCode2, color: "#d4a20b", label: "JavaScript" },
  cjs: { Icon: FileCode2, color: "#d4a20b", label: "JavaScript" },
  css: { Icon: Hash, color: "#2965f1", label: "CSS" },
  html: { Icon: FileCode2, color: "#e34c26", label: "HTML" },
  json: { Icon: Braces, color: "#cb8a00", label: "JSON" },
  md: { Icon: FileText, color: "#519aba", label: "Markdown" },
  sql: { Icon: Database, color: "#c2410c", label: "SQL" },
  svg: { Icon: FileImage, color: "#d97706", label: "SVG" },
  png: { Icon: FileImage, color: "#8b5cf6", label: "Image" },
  jpg: { Icon: FileImage, color: "#8b5cf6", label: "Image" },
  jpeg: { Icon: FileImage, color: "#8b5cf6", label: "Image" },
  webp: { Icon: FileImage, color: "#8b5cf6", label: "Image" },
  ico: { Icon: FileImage, color: "#8b5cf6", label: "Image" },
};
const CONFIG = /(^|\/)(\.[\w.-]+|[\w-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json|package(-lock)?\.json)$/;

export function fileKind(path: string): Kind {
  const name = path.split("/").pop() ?? path;
  if (CONFIG.test(path) && !name.endsWith(".md")) return { Icon: Settings2, color: "#6f6f7a", label: "Config" };
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return BY_EXT[ext] ?? { Icon: File, color: "var(--muted)", label: "File" };
}

/** A file-type icon, like VS Code's: TypeScript blue, CSS, JSON braces, images. */
export default function FileIcon({ path, className = "h-3.5 w-3.5" }: { path: string; className?: string }) {
  const { Icon, color } = fileKind(path);
  return <Icon className={`${className} shrink-0`} style={{ color }} aria-hidden />;
}
