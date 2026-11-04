import { db } from "./db";
import { copyAssetsTo } from "./design-assets";
import { commit, listFiles, readFile, writeFiles } from "./repo";
import { currentDraftId } from "./drafts";

/**
 * Design systems: a project of kind "design_system" holds tokens (colours,
 * type, radius, density) in design-system.json and publishes numbered
 * versions. An app attaches one: its tokens are installed as the app's CSS
 * variables, the agent follows them every turn, and a newer published
 * version shows up as an update.
 */

export type Tokens = {
  name: string;
  colors: Record<"primary" | "secondary" | "accent" | "background" | "foreground" | "muted" | "border" | "destructive", string>;
  fonts: { heading: string; body: string };
  radius: string;
  density: "comfortable" | "compact";
  guidance: string;
};

export const DEFAULT_TOKENS: Tokens = {
  name: "Untitled design system",
  colors: {
    primary: "#6d4aff",
    secondary: "#f1f0fb",
    accent: "#ffb547",
    background: "#ffffff",
    foreground: "#16141f",
    muted: "#6b6880",
    border: "#e6e4ef",
    destructive: "#e5484d",
  },
  fonts: { heading: "Inter", body: "Inter" },
  radius: "0.75rem",
  density: "comfortable",
  guidance: "Calm, generous spacing. One primary action per screen. Use the accent sparingly for highlights.",
};

export class DesignSystemError extends Error {}

const HEX = /^#([0-9a-f]{6})$/i;

/** "#6d4aff" → "253 100% 65%", the format the app's CSS variables use. */
export function hexToHsl(hex: string) {
  const m = HEX.exec(hex.trim());
  if (!m) throw new DesignSystemError(`"${hex}" isn't a 6-digit hex colour.`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** Readable text colour for a background: near-white or near-black. */
function onColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "222 47% 11%" : "210 40% 98%";
}

export function validateTokens(t: Tokens): Tokens {
  for (const [k, v] of Object.entries(t.colors)) {
    if (!HEX.test(v)) throw new DesignSystemError(`Colour "${k}" must be a 6-digit hex value like #6d4aff.`);
  }
  if (!/^\d+(\.\d+)?(rem|px)$/.test(t.radius)) throw new DesignSystemError("Radius must look like 0.75rem or 12px.");
  if (!t.fonts.heading?.trim() || !t.fonts.body?.trim()) throw new DesignSystemError("Choose a heading and a body font.");
  return { ...t, name: t.name.trim().slice(0, 60) || "Design system", guidance: (t.guidance ?? "").slice(0, 2000) };
}

/** The CSS block installed into an app, between markers so it can be replaced on update. */
export function tokensCss(t: Tokens, version: number) {
  const c = t.colors;
  const fontUrl = (f: string) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@400;500;600;700&display=swap`;
  return `/* forge-design-system:start ${t.name} v${version} — managed by the platform; edit the design system, not this block */
@import url("${fontUrl(t.fonts.body)}");
${t.fonts.heading !== t.fonts.body ? `@import url("${fontUrl(t.fonts.heading)}");\n` : ""}:root {
  --background: ${hexToHsl(c.background)};
  --foreground: ${hexToHsl(c.foreground)};
  --primary: ${hexToHsl(c.primary)};
  --primary-foreground: ${onColor(c.primary)};
  --secondary: ${hexToHsl(c.secondary)};
  --secondary-foreground: ${onColor(c.secondary)};
  --accent: ${hexToHsl(c.accent)};
  --accent-foreground: ${onColor(c.accent)};
  --muted: ${hexToHsl(c.secondary)};
  --muted-foreground: ${hexToHsl(c.muted)};
  --border: ${hexToHsl(c.border)};
  --input: ${hexToHsl(c.border)};
  --ring: ${hexToHsl(c.primary)};
  --destructive: ${hexToHsl(c.destructive)};
  --destructive-foreground: 210 40% 98%;
  --radius: ${t.radius};
  --font-body: "${t.fonts.body}", ui-sans-serif, system-ui, sans-serif;
  --font-heading: "${t.fonts.heading}", ui-sans-serif, system-ui, sans-serif;
}
body { font-family: var(--font-body); }
h1, h2, h3, h4 { font-family: var(--font-heading); }
/* forge-design-system:end */`;
}

/** A design system's style guide page, so its preview shows the tokens in use. */
const STYLE_GUIDE = `import tokens from "../design-system.json";

const swatches = Object.entries(tokens.colors) as [string, string][];

export default function App() {
  return (
    <main style={{ fontFamily: tokens.fonts.body, padding: 40, maxWidth: 960, margin: "0 auto", color: tokens.colors.foreground, background: tokens.colors.background, minHeight: "100vh" }}>
      <p style={{ textTransform: "uppercase", letterSpacing: 2, fontSize: 12, color: tokens.colors.muted }}>Design system</p>
      <h1 style={{ fontFamily: tokens.fonts.heading, fontSize: 40, margin: "4px 0 8px" }}>{tokens.name}</h1>
      <p style={{ color: tokens.colors.muted, maxWidth: 600 }}>{tokens.guidance}</p>
      <h2 style={{ fontFamily: tokens.fonts.heading, marginTop: 40 }}>Colours</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
        {swatches.map(([name, hex]) => (
          <div key={name} style={{ border: \`1px solid \${tokens.colors.border}\`, borderRadius: tokens.radius, overflow: "hidden" }}>
            <div style={{ height: 64, background: hex }} />
            <div style={{ padding: 8, fontSize: 13 }}>
              <strong>{name}</strong>
              <div style={{ color: tokens.colors.muted }}>{hex}</div>
            </div>
          </div>
        ))}
      </div>
      <h2 style={{ fontFamily: tokens.fonts.heading, marginTop: 40 }}>Type</h2>
      <p style={{ fontFamily: tokens.fonts.heading, fontSize: 32, margin: 0 }}>Heading — {tokens.fonts.heading}</p>
      <p style={{ fontSize: 16 }}>Body text — {tokens.fonts.body}. The quick brown fox jumps over the lazy dog.</p>
      <h2 style={{ fontFamily: tokens.fonts.heading, marginTop: 40 }}>Components</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button style={{ background: tokens.colors.primary, color: "#fff", border: 0, borderRadius: tokens.radius, padding: "10px 18px", fontWeight: 600 }}>Primary</button>
        <button style={{ background: tokens.colors.secondary, color: tokens.colors.foreground, border: \`1px solid \${tokens.colors.border}\`, borderRadius: tokens.radius, padding: "10px 18px" }}>Secondary</button>
        <span style={{ background: tokens.colors.accent, borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600 }}>Badge</span>
        <input placeholder="Input" style={{ border: \`1px solid \${tokens.colors.border}\`, borderRadius: tokens.radius, padding: "10px 12px" }} />
      </div>
    </main>
  );
}
`;

async function recordHead(projectId: string, sha: string) {
  const draft = await currentDraftId(projectId);
  if (draft) await db.draft.update({ where: { id: draft }, data: { headSha: sha } });
  else await db.project.update({ where: { id: projectId }, data: { headSha: sha } });
}

/** Turn a freshly scaffolded project into a design system with a style guide. */
export async function initDesignSystem(projectId: string, name: string) {
  const tokens = { ...DEFAULT_TOKENS, name };
  await writeFiles(projectId, [
    { path: "design-system.json", content: JSON.stringify(tokens, null, 2) },
    { path: "src/App.tsx", content: STYLE_GUIDE },
  ]);
  const sha = await commit(projectId, "Create design system");
  await db.project.update({ where: { id: projectId }, data: { kind: "design_system", headSha: sha } });
}

export async function readTokens(projectId: string): Promise<Tokens> {
  const raw = await readFile(projectId, "design-system.json").catch(() => null);
  if (!raw) throw new DesignSystemError("This project has no design-system.json.");
  return { ...DEFAULT_TOKENS, ...(JSON.parse(raw) as Partial<Tokens>) };
}

export async function saveTokens(projectId: string, tokens: Tokens) {
  const clean = validateTokens(tokens);
  await writeFiles(projectId, [{ path: "design-system.json", content: JSON.stringify(clean, null, 2) }]);
  const sha = await commit(projectId, "Update design tokens");
  await recordHead(projectId, sha);
  await db.project.update({ where: { id: projectId }, data: { name: clean.name } });
  return clean;
}

/** Publish the current tokens as the next version, kept in the design system's history. */
export async function publishDesignSystem(projectId: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  if (p.kind !== "design_system") throw new DesignSystemError("Only design systems can be published as a version.");
  const tokens = validateTokens(await readTokens(projectId));
  const version = p.dsVersion + 1;
  await writeFiles(projectId, [{ path: `versions/v${version}.json`, content: JSON.stringify(tokens, null, 2) }]);
  const sha = await commit(projectId, `Publish design system v${version}`);
  await recordHead(projectId, sha);
  await db.project.update({ where: { id: projectId }, data: { dsVersion: version } });
  return version;
}

async function publishedTokens(dsId: string, version: number) {
  const raw = await readFile(dsId, `versions/v${version}.json`).catch(() => null);
  if (!raw) throw new DesignSystemError(`Version ${version} of this design system is missing.`);
  return JSON.parse(raw) as Tokens;
}

/**
 * Install (or update to) the latest published version in an app: replaces
 * the managed block in src/index.css and writes the tokens for the agent.
 */
const IMPORT_MARK = "/* forge-design-system-font */";

export async function attachDesignSystem(appId: string, dsId: string) {
  const [app, ds] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: appId } }),
    db.project.findUnique({ where: { id: dsId } }),
  ]);
  if (!ds || ds.kind !== "design_system" || ds.workspaceId !== app.workspaceId || ds.deletedAt) {
    throw new DesignSystemError("That design system isn't in this workspace.");
  }
  if (ds.dsVersion < 1) throw new DesignSystemError(`Publish a version of ${ds.name} before attaching it.`);
  if (app.kind !== "app") throw new DesignSystemError("Design systems attach to app projects.");
  const tokens = await publishedTokens(dsId, ds.dsVersion);
  const css = (await readFile(appId, "src/index.css").catch(() => "")) || "";
  const block = tokensCss(tokens, ds.dsVersion);
  const managed = /\/\* forge-design-system:start[\s\S]*?forge-design-system:end \*\//;
  // Font imports must lead the file, so they sit above the block with a marker that lets an update replace them too.
  const withoutOld = css
    .replace(managed, "")
    .split("\n")
    .filter((l) => !l.endsWith(IMPORT_MARK))
    .join("\n")
    .replace(/^\s+/, "");
  const imports = block
    .split("\n")
    .filter((l) => l.startsWith("@import"))
    .map((l) => `${l} ${IMPORT_MARK}`)
    .join("\n");
  const rest = block
    .split("\n")
    .filter((l) => !l.startsWith("@import"))
    .join("\n");
  const next = `${imports}\n${withoutOld.trimEnd()}\n\n${rest}\n`;
  await writeFiles(appId, [
    { path: "src/index.css", content: next },
    { path: "src/design-system/tokens.json", content: JSON.stringify({ ...tokens, version: ds.dsVersion, source: ds.name }, null, 2) },
  ]);
  // The asset bundle (logos, icons, fonts) comes along into public/brand/.
  const assets = await copyAssetsTo(dsId, appId);
  const sha = await commit(appId, `${app.designSystemId === dsId ? "Update" : "Attach"} design system ${ds.name} v${ds.dsVersion}`);
  await recordHead(appId, sha);
  await db.project.update({ where: { id: appId }, data: { designSystemId: dsId, designSystemVersion: ds.dsVersion } });
  return { name: ds.name, version: ds.dsVersion, assets };
}

/** What the agent should know about the app's design system, or null. */
export async function designSystemContext(appId: string) {
  const app = await db.project.findUnique({ where: { id: appId }, select: { designSystemId: true, designSystemVersion: true } });
  if (!app?.designSystemId || !app.designSystemVersion) return null;
  const tokens = await publishedTokens(app.designSystemId, app.designSystemVersion).catch(() => null);
  if (!tokens) return null;
  const brand = (await listFiles(appId).catch(() => [] as string[])).filter((f) => f.startsWith("public/brand/"));
  return {
    name: tokens.name,
    version: app.designSystemVersion,
    prompt:
      `This app uses the attached design system "${tokens.name}" v${app.designSystemVersion}. Follow it: colours come from ` +
      `the CSS variables (bg-primary, text-muted-foreground, border-border and so on), never hard-coded hex values; ` +
      `headings use the heading font and body the body font; corners use the radius tokens; density is ${tokens.density}. ` +
      `Do not edit the forge-design-system block in src/index.css. Guidance: ${tokens.guidance}` +
      (brand.length ? ` Brand assets from the design system are in public/brand/ (${brand.map((b) => b.slice("public".length)).join(", ")}): use them (e.g. the logo) instead of placeholders, referenced from the site root.` : ""),
  };
}

/** "12 80% 50%" or "hsl(12 80% 50%)" → "#rrggbb". */
export function hslToHex(raw: string): string | null {
  const m = /(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(raw);
  if (!m) return null;
  const [h, s, l] = [Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100];
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Read the tokens an existing app already uses: CSS variables, radius and fonts. */
export async function tokensFromApp(appId: string, name: string): Promise<Tokens> {
  const css = (await readFile(appId, "src/index.css").catch(() => "")) || "";
  const tw = (await readFile(appId, "tailwind.config.ts").catch(() => "")) || "";
  // The light theme: the first :root block.
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const v = (name: string) => new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(root)?.[1]?.trim() ?? null;
  const color = (name: string) => {
    const raw = v(name);
    if (!raw) return null;
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    return hslToHex(raw);
  };
  const colors = { ...DEFAULT_TOKENS.colors };
  const map: [keyof Tokens["colors"], string][] = [
    ["primary", "primary"],
    ["secondary", "secondary"],
    ["accent", "accent"],
    ["background", "background"],
    ["foreground", "foreground"],
    ["muted", "muted-foreground"],
    ["border", "border"],
    ["destructive", "destructive"],
  ];
  for (const [key, cssName] of map) colors[key] = color(cssName) ?? colors[key];
  const families = [...css.matchAll(/fonts\.googleapis\.com\/css2\?family=([A-Za-z+]+)/g)].map((m) => m[1].replace(/\+/g, " "));
  const twSans = /sans:\s*\[\s*["']([^"']+)["']/.exec(tw)?.[1];
  const twHeading = /(?:heading|display):\s*\[\s*["']([^"']+)["']/.exec(tw)?.[1];
  const body = twSans ?? families[0] ?? DEFAULT_TOKENS.fonts.body;
  return validateTokens({
    ...DEFAULT_TOKENS,
    name,
    colors,
    fonts: { heading: twHeading ?? families[1] ?? body, body },
    radius: /^\d+(\.\d+)?(rem|px)$/.test(v("radius") ?? "") ? v("radius")! : DEFAULT_TOKENS.radius,
    guidance: `Extracted from the app it was made from. ${DEFAULT_TOKENS.guidance}`,
  });
}
