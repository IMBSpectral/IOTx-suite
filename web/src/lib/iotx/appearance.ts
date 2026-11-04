/**
 * IOTx Suite appearance: theme (light, dark, system), accent (four presets
 * or one custom colour) and the shell background (none, a solid colour, or
 * an uploaded image with a dim and blur overlay). Saved to the account
 * (User.theme / accent / accentCustom / shellBg) and mirrored in
 * localStorage so the layout script applies it before the first paint.
 *
 * A custom accent is one colour; its gradient partner, hover and soft
 * variants are derived from it, and its lightness is nudged in each theme
 * until accent text reads at 4.5:1 on the page and the text on accent
 * buttons reads at 4.5:1 too. Pure functions: used by server and client.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type AccentId = "indigo" | "ember" | "teal" | "graphite" | "custom";
export type ShellBg = { kind: "none" | "color" | "image"; color?: string; image?: string; dim?: number; blur?: number };
export type Appearance = { theme: ThemeChoice; accent: AccentId; accentCustom: string | null; shellBg: ShellBg };

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accent: "indigo", accentCustom: null, shellBg: { kind: "none" } };

export const PRESETS: Record<Exclude<AccentId, "custom">, { label: string; base: string; partner: string }> = {
  indigo: { label: "Indigo", base: "#4f46e5", partner: "#8b5cf6" },
  ember: { label: "Ember", base: "#e8590c", partner: "#f59f00" },
  teal: { label: "Teal", base: "#0d9488", partner: "#22b8cf" },
  graphite: { label: "Graphite", base: "#2b2f45", partner: "#6b7194" },
};

/** Page backgrounds the accent is checked against. */
export const PAGE_BG = { light: "#f7f7fc", dark: "#0c0d18" };
export const PAGE_TEXT = { light: "#14152b", dark: "#ebecf8" };

export type Palette = Record<"--accent" | "--accent-2" | "--accent-hover" | "--accent-soft" | "--on-accent" | "--glow-1" | "--glow-2", string>;

// ── Colour maths ────────────────────────────────────────────────────────────

export const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
const toHex = ([r, g, b]: [number, number, number]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function luminance(hex: string) {
  const ch = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number) {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

function mix(a: string, b: string, t: number) {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

const alpha = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgb(${r} ${g} ${b} / ${a})`;
};

/** Nudge a colour's lightness until it reads at `min`:1 on `bg`. */
function readableOn(hex: string, bg: string, min = 4.5) {
  let [h, s, l] = toHsl(hex);
  const darker = luminance(bg) > 0.4;
  for (let i = 0; i < 60 && contrast(fromHsl(h, s, l), bg) < min; i++) l = Math.max(0, Math.min(100, l + (darker ? -1.5 : 1.5)));
  return fromHsl(h, s, l);
}

/** The palette for one theme from a base colour (and an optional gradient partner). */
export function derivePalette(base: string, mode: "light" | "dark", partner?: string): Palette {
  const bg = PAGE_BG[mode];
  const a = readableOn(base, bg);
  const [h, s, l] = toHsl(a);
  const p2 = partner ? readableOn(partner, bg, 3) : readableOn(fromHsl((h + 32) % 360, Math.min(100, s + 6), l), bg, 3);
  const hover = fromHsl(h, s, mode === "light" ? Math.max(0, l - 7) : Math.min(100, l + 7));
  const soft = mix(a, bg, mode === "light" ? 0.88 : 0.8);
  // Text on accent buttons: white when it reads, else near-black.
  const onAccent = contrast("#ffffff", a) >= 4.5 ? "#ffffff" : "#111225";
  return {
    "--accent": a,
    "--accent-2": p2,
    "--accent-hover": hover,
    "--accent-soft": soft,
    "--on-accent": onAccent,
    "--glow-1": alpha(a, mode === "light" ? 0.18 : 0.24),
    "--glow-2": alpha(p2, mode === "light" ? 0.14 : 0.12),
  };
}

export function palettesFor(accent: AccentId, custom: string | null) {
  const preset = accent !== "custom" ? PRESETS[accent] : null;
  const base = preset?.base ?? (custom && HEX.test(custom) ? custom : PRESETS.indigo.base);
  // Graphite is near-black: in dark mode it turns into a light slate.
  const darkBase = accent === "graphite" ? "#b9bdd6" : base;
  return {
    light: derivePalette(base, "light", preset?.partner),
    dark: derivePalette(darkBase, "dark", accent === "graphite" ? "#8a90b4" : preset?.partner),
  };
}

/** A check the settings screen shows next to a custom colour. */
export function contrastReport(custom: string) {
  const p = palettesFor("custom", custom);
  return {
    light: { accent: p.light["--accent"], onPage: contrast(p.light["--accent"], PAGE_BG.light), onButton: contrast(p.light["--on-accent"], p.light["--accent"]), adjusted: p.light["--accent"].toLowerCase() !== custom.toLowerCase() },
    dark: { accent: p.dark["--accent"], onPage: contrast(p.dark["--accent"], PAGE_BG.dark), onButton: contrast(p.dark["--on-accent"], p.dark["--accent"]), adjusted: p.dark["--accent"].toLowerCase() !== custom.toLowerCase() },
  };
}

/** Clean a saved/posted appearance. */
export function cleanAppearance(input: Partial<Appearance> & Record<string, unknown>, current: Appearance = DEFAULT_APPEARANCE): Appearance {
  const theme = (["light", "dark", "system"] as const).includes(input.theme as ThemeChoice) ? (input.theme as ThemeChoice) : current.theme;
  const accent = (["indigo", "ember", "teal", "graphite", "custom"] as const).includes(input.accent as AccentId) ? (input.accent as AccentId) : current.accent;
  const accentCustom = typeof input.accentCustom === "string" && HEX.test(input.accentCustom) ? input.accentCustom.toLowerCase() : input.accentCustom === null ? null : current.accentCustom;
  const raw = (input.shellBg ?? current.shellBg) as ShellBg;
  const kind = raw?.kind === "color" || raw?.kind === "image" ? raw.kind : "none";
  const shellBg: ShellBg = { kind };
  if (kind === "color") shellBg.color = typeof raw.color === "string" && HEX.test(raw.color) ? raw.color.toLowerCase() : "#eef0ff";
  if (kind === "image") {
    if (typeof raw.image !== "string" || !/^\/api\/account\/appearance\?bg=[\w.-]+$/.test(raw.image)) shellBg.kind = "none";
    else shellBg.image = raw.image;
  }
  if (kind !== "none") {
    shellBg.dim = Math.max(0, Math.min(85, Math.round(Number(raw.dim ?? 35)) || 0));
    shellBg.blur = Math.max(0, Math.min(24, Math.round(Number(raw.blur ?? 0)) || 0));
  }
  return { theme, accent: accent === "custom" && !accentCustom ? current.accent === "custom" ? "indigo" : current.accent : accent, accentCustom, shellBg };
}

/**
 * The overlay that keeps text readable over a background: the image always
 * gets the chosen dim; a solid colour that doesn't read against the theme's
 * text gets the least overlay that makes it read.
 */
export function overlayFor(bg: ShellBg, mode: "light" | "dark") {
  if (bg.kind === "image") return Math.max(bg.dim ?? 35, 20) / 100;
  if (bg.kind === "color" && bg.color) {
    for (let t = 0; t <= 0.9; t += 0.05) if (contrast(PAGE_TEXT[mode], mix(bg.color, PAGE_BG[mode], t)) >= 7) return Math.max(t, (bg.dim ?? 0) / 100);
    return 0.9;
  }
  return 0;
}

/** Stored in localStorage for the before-paint script in the root layout. */
export function paintPayload(a: Appearance) {
  return { theme: a.theme, palettes: palettesFor(a.accent, a.accentCustom) };
}
