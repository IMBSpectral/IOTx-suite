/**
 * People who run this Forge install (FORGE_ADMIN_EMAILS, comma-separated).
 * Not a workspace role: it covers platform-wide things like announcements.
 */
export function isPlatformAdmin(email: string | null | undefined) {
  if (!email) return false;
  const list = (process.env.FORGE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
