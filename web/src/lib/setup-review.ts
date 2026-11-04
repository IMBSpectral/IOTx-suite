import { db } from "./db";
import { getBrand } from "./brand";
import { listFiles, readFile } from "./repo";
import { getCloud, listMigrations } from "./cloud";
import { listConnections } from "./connectors";
import { domainStatus } from "./domains";
import type { SecurityConfig } from "./security";
import type { Seo } from "./publish";
import { mapsSetup } from "./google-maps";

/**
 * "Review project setup": what to check before publishing, in one list:
 * page title and description, favicon, the backend (secrets the app asked
 * for, pending migrations), connectors, security (scan and pentest), and the
 * custom domain. Each item says what's missing and where to fix it.
 */
export type SetupItem = { id: string; label: string; status: "ok" | "warn" | "todo"; detail: string; tab?: string };

export async function reviewSetup(projectId: string): Promise<SetupItem[]> {
  const p = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      workspaceId: true,
      seo: true,
      customDomain: true,
      securityConfig: true,
      _count: { select: { findings: { where: { resolved: false, ignored: false, severity: { in: ["CRITICAL", "HIGH"] } } } } },
    },
  });
  const items: SetupItem[] = [];
  const files = await listFiles(projectId).catch(() => [] as string[]);

  const seo = (p.seo as Seo | null) ?? {};
  const html = await readFile(projectId, "index.html").catch(() => "");
  const title = seo.title || /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || "";
  const description = seo.description || /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] || "";
  const generic = /^(vite|react|untitled|my app|lovable|forge)/i.test(title);
  items.push(
    title && !generic && description
      ? { id: "seo", label: "Page title and description", status: "ok", detail: title }
      : { id: "seo", label: "Page title and description", status: "todo", detail: !title || generic ? "The page title is missing or generic." : "There's no meta description for search and link previews.", tab: "publish" },
  );
  const favicon = files.some((f) => /^public\/(favicon|icon)\.(ico|png|svg)$/i.test(f)) || /rel="icon"/i.test(html);
  items.push({ id: "favicon", label: "Favicon", status: favicon ? "ok" : "warn", detail: favicon ? "Set" : "Browsers will show a default icon. Ask the agent to add one.", tab: favicon ? undefined : "chat" });

  const cloud = await getCloud(projectId);
  if (cloud?.enabled) {
    const missing = cloud.requestedSecrets.filter((r) => !cloud.secrets[r.name]);
    items.push(
      missing.length
        ? { id: "secrets", label: "Backend secrets", status: "todo", detail: `The app is waiting for ${missing.map((m) => m.name).join(", ")}.`, tab: "cloud" }
        : { id: "secrets", label: "Backend secrets", status: "ok", detail: "Every secret the app asked for is set." },
    );
    const pending = (await listMigrations(projectId).catch(() => [])).filter((m) => m.status === "pending");
    items.push(
      pending.length
        ? { id: "migrations", label: "Database changes", status: "todo", detail: `${pending.length} database change${pending.length === 1 ? "" : "s"} waiting for approval.`, tab: "cloud" }
        : { id: "migrations", label: "Database changes", status: "ok", detail: "Nothing waiting." },
    );
  }

  const broken = (await listConnections(p.workspaceId, projectId)).filter((c) => c.status === "failed");
  if (broken.length) {
    items.push({ id: "connectors", label: "Connectors", status: "warn", detail: `${broken.map((c) => c.label).join(", ")} failed their last check.`, tab: "settings" });
  }

  const sec = (p.securityConfig as SecurityConfig | null) ?? {};
  if (p._count.findings) {
    items.push({ id: "security", label: "Security scan", status: "todo", detail: `${p._count.findings} critical or high issue${p._count.findings === 1 ? "" : "s"} open.`, tab: "security" });
  } else if (!sec.lastScanAt) {
    items.push({ id: "security", label: "Security scan", status: "warn", detail: "Not scanned yet. Publishing runs one, or scan now.", tab: "security" });
  } else items.push({ id: "security", label: "Security scan", status: "ok", detail: `Last scan ${new Date(sec.lastScanAt).toLocaleDateString()}` });
  if (sec.pentest) {
    const serious = sec.pentest.findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
    items.push({
      id: "pentest",
      label: "Pentest",
      status: serious ? "todo" : "ok",
      detail: serious ? `${serious} serious finding${serious === 1 ? "" : "s"} from the last pentest.` : `${sec.pentest.findings.length} minor finding${sec.pentest.findings.length === 1 ? "" : "s"} from the last pentest.`,
      tab: serious ? "security" : undefined,
    });
  }

  // Google Maps: works on the Forge URL with Forge's key; a custom domain needs the app's own.
  const maps = await mapsSetup(projectId, p.customDomain);
  if (maps) {
    items.push(
      maps.own
        ? { id: "maps", label: "Google Maps", status: "ok", detail: "The app uses your own Google Maps API key." }
        : maps.platform && !maps.customDomain
          ? { id: "maps", label: "Google Maps", status: "ok", detail: `Google Maps works automatically on your ${getBrand().shortName} URL.` }
          : maps.platform
            ? {
                id: "maps",
                label: "Google Maps",
                status: "warn",
                detail: `Google Maps works automatically on your ${getBrand().shortName} URL. To use it on your own domain, connect your own Google Maps API key.`,
                tab: "maps",
              }
            : { id: "maps", label: "Google Maps", status: "todo", detail: "The app shows Google Maps but has no API key yet, so maps won't load.", tab: "maps" },
    );
  }

  if (p.customDomain) {
    const d = await domainStatus(p.customDomain).catch(() => null);
    items.push(
      d?.status === "active"
        ? { id: "domain", label: "Custom domain", status: "ok", detail: `${p.customDomain} is connected.` }
        : { id: "domain", label: "Custom domain", status: "warn", detail: d?.message ?? "Couldn't check the domain.", tab: "settings" },
    );
  }
  return items;
}
