/**
 * A project card's 16:9 tile. Until Forge can capture screenshots, each
 * project gets a soft gradient picked from its id, with its emoji or initial,
 * so cards are recognisable at a glance and the grid has Lovable's rhythm.
 */
const PALETTES = [
  ["#ede9fe", "#c4b5fd"],
  ["#e0f2fe", "#7dd3fc"],
  ["#dcfce7", "#86efac"],
  ["#fef3c7", "#fcd34d"],
  ["#fce7f3", "#f9a8d4"],
  ["#ffedd5", "#fdba74"],
  ["#e2e8f0", "#94a3b8"],
  ["#ccfbf1", "#5eead4"],
];

function pick(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

export default function ProjectThumb({
  id,
  name,
  emoji,
  kind,
  live,
}: {
  id: string;
  name: string;
  emoji: string | null;
  kind?: string;
  live?: boolean;
}) {
  const [from, to] = pick(id);
  const badge = kind === "canvas" ? "Canvas" : kind === "design_system" ? "Design system" : kind === "library" ? "Library" : null;
  return (
    <div
      className="card-lift-media relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl transition-shadow"
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
      aria-hidden
    >
      <span className="select-none text-4xl font-semibold text-black/40">{emoji ?? name.trim().charAt(0).toUpperCase()}</span>
      {(badge || live) && (
        <span className="absolute left-2 top-2 flex gap-1">
          {badge && <span className="rounded-md bg-white/85 px-1.5 py-0.5 text-[11px] font-medium text-black/70">{badge}</span>}
          {live && <span className="rounded-md bg-white/85 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">Live</span>}
        </span>
      )}
    </div>
  );
}
