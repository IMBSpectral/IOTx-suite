import { listFiles, readFile } from "./repo";
import { readEnvNames } from "./env-vars";

/**
 * Google Maps for published apps. Apps read their key from
 * import.meta.env.VITE_GOOGLE_MAPS_API_KEY. If the app has no key of its own
 * and Forge has one (FORGE_GOOGLE_MAPS_KEY, restricted to Forge's own site
 * domain), Forge's key is used for builds, so maps work on the Forge URL out
 * of the box; a custom domain needs the app's own key.
 */

export const MAPS_ENV = "VITE_GOOGLE_MAPS_API_KEY";
const USES = /maps\.googleapis\.com|@vis\.gl\/react-google-maps|@react-google-maps|google\.maps\.|VITE_GOOGLE_MAPS_API_KEY/;

export async function usesGoogleMaps(projectId: string) {
  const files = (await listFiles(projectId).catch(() => [] as string[])).filter((f) => /^(src\/.*\.(t|j)sx?|index\.html|package\.json)$/.test(f)).slice(0, 400);
  for (const f of files) {
    if (USES.test(await readFile(projectId, f).catch(() => ""))) return true;
  }
  return false;
}

export const platformMapsKey = () => process.env.FORGE_GOOGLE_MAPS_KEY?.trim() || null;

export async function mapsSetup(projectId: string, customDomain: string | null) {
  if (!(await usesGoogleMaps(projectId))) return null;
  const own = (await readEnvNames(projectId)).includes(MAPS_ENV);
  const platform = !!platformMapsKey();
  return { own, platform, customDomain: !!customDomain };
}

/** Shell prefix for a build: Forge's key, only when the app uses Maps and has no key of its own. */
export async function mapsBuildEnv(projectId: string) {
  const key = platformMapsKey();
  if (!key || !/^[\w-]{10,100}$/.test(key)) return "";
  if (!(await usesGoogleMaps(projectId))) return "";
  if ((await readEnvNames(projectId)).includes(MAPS_ENV)) return "";
  return `${MAPS_ENV}=${key} `;
}
