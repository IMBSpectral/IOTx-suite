import { db } from "../db";
import { cleanAppearance, DEFAULT_APPEARANCE, type Appearance } from "./appearance";

/** A person's saved appearance (defaults when they never changed it). */
export async function loadAppearance(userId: string): Promise<Appearance> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { theme: true, accent: true, accentCustom: true, shellBg: true } });
  if (!u) return DEFAULT_APPEARANCE;
  return cleanAppearance({ theme: u.theme, accent: u.accent, accentCustom: u.accentCustom, shellBg: (u.shellBg as Appearance["shellBg"] | null) ?? { kind: "none" } } as Partial<Appearance>);
}
