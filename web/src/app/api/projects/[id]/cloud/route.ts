import { cloudKey, requireProjectPerm } from "@/lib/iotx/permissions";
import { getBrand } from "@/lib/brand";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { writeFiles, commit } from "@/lib/repo";
import { db } from "@/lib/db";
import { currentDraftId } from "@/lib/drafts";
import {
  applyMigration,
  browseTable,
  CLIENT_PATH,
  clientSource,
  CloudError,
  cloudUrl,
  deleteSecret,
  enableCloud,
  getCloud,
  listAuthUsers,
  listMigrations,
  listTables,
  rejectMigration,
  setPolicy,
  setSecret,
  type Access,
  inheritedSecretNames,
} from "@/lib/cloud";
import { hasLive } from "@/lib/cloud-envs";
import { cloudHealth, emailRate, lintCloud, optimizeDatabase, pauseCloud, readOutbox, refreshDeliveries, restartCloud, setFeatures, wakeCloud } from "@/lib/cloud-ops";
import { activateDomain, addDomain, checkDomain, readDomains, removeDomain } from "@/lib/app-email-domain";

type Ctx = { params: Promise<{ id: string }> };

/** Cloud overview for the editor: status, tables, migrations, users, secrets (names only). */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const cfg = await getCloud(id);
  if (!cfg?.enabled) return Response.json({ enabled: false });
  const table = new URL(req.url).searchParams.get("table");
  if (table) return Response.json({ rows: await browseTable(id, table) });
  const view = new URL(req.url).searchParams.get("view");
  if (view === "health") return Response.json(await cloudHealth(id));
  if (view === "lint") return Response.json({ findings: await lintCloud(id) });
  if (view === "outbox") return Response.json({ emails: await readOutbox(id), rate: await emailRate(id) });
  if (view === "emailDomains") return Response.json(await readDomains(id));
  const [tables, migrations, users] = await Promise.all([listTables(id), listMigrations(id), listAuthUsers(id)]);
  return Response.json({
    enabled: true,
    url: cloudUrl(id),
    anonKey: cfg.anonKey,
    tables,
    migrations,
    users,
    secrets: Object.entries(cfg.secrets).map(([name, s]) => ({ name, updatedAt: s.updatedAt })),
    inheritedSecrets: await inheritedSecretNames(id),
    hasLive: await hasLive(id),
    requestedSecrets: cfg.requestedSecrets,
  });
}

/** Writes the client file into the app and commits it where the preview is looking. */
async function installClient(projectId: string, anonKey: string) {
  await writeFiles(projectId, [{ path: CLIENT_PATH, content: clientSource(projectId, anonKey) }]);
  const sha = await commit(projectId, `Enable ${getBrand().shortName} Cloud`);
  const draft = await currentDraftId(projectId);
  if (draft) await db.draft.update({ where: { id: draft }, data: { headSha: sha } });
  else await db.project.update({ where: { id: projectId }, data: { headSha: sha } });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    name?: string;
    value?: string;
    ai?: boolean;
    email?: boolean;
    fromName?: string;
    mailboxId?: string | null;
    table?: string;
    read?: Access;
    write?: Access;
  };
  try {
    await requireProjectPerm(user.id, id, cloudKey(body.action));
    switch (body.action) {
      case "enable": {
        // Approving Cloud: the backend and the app's client file arrive together.
        const running = await db.build.count({ where: { projectId: id, status: "RUNNING" } });
        const cfg = await enableCloud(id);
        if (!running) await installClient(id, cfg.anonKey);
        return Response.json({ ok: true, url: cloudUrl(id) });
      }
      case "pause":
        await pauseCloud(id, "manual", true);
        return Response.json({ ok: true });
      case "wake":
        await wakeCloud(id);
        return Response.json({ ok: true });
      case "optimize": {
        const migration = await optimizeDatabase(id);
        return Response.json({ ok: true, migration });
      }
      case "restart":
        await restartCloud(id);
        return Response.json({ ok: true });
      case "features":
        if (body.mailboxId) {
          const { isAppSender } = await import("@/lib/app-mail");
          if (!(await isAppSender(id, body.mailboxId))) return Response.json({ error: "Choose one of the workspace's shared mailboxes." }, { status: 400 });
        }
        await setFeatures(id, { ai: body.ai, email: body.email, fromName: body.fromName, mailboxId: body.mailboxId === undefined ? undefined : body.mailboxId || null });
        return Response.json({ ok: true });
      case "emailDomain": {
        // Branded sending domain: add · check · activate (id or null, and/or localPart) · remove
        const b = body as typeof body & { op?: string; domain?: string; localPart?: string };
        if (b.op === "add") return Response.json({ domain: await addDomain(id, b.domain ?? "") });
        if (b.op === "check") return Response.json({ domain: await checkDomain(id, b.id ?? "") });
        if (b.op === "activate") return Response.json(await activateDomain(id, b.id === undefined ? undefined : b.id || null, b.localPart));
        if (b.op === "remove") return Response.json(await removeDomain(id, b.id ?? ""));
        return Response.json({ error: "Unknown domain step" }, { status: 400 });
      }
      case "refreshDeliveries":
        return Response.json({ emails: await refreshDeliveries(id) });
      case "refreshClient": {
        // Older apps have a client without ai/email; this installs the current one.
        const cfg = await getCloud(id);
        if (!cfg?.enabled) return Response.json({ error: `${getBrand().shortName} Cloud is off.` }, { status: 404 });
        await installClient(id, cfg.anonKey);
        return Response.json({ ok: true });
      }
      case "approve":
        return Response.json({ ok: true, migration: await applyMigration(id, body.id ?? "") });
      case "reject":
        await rejectMigration(id, body.id ?? "");
        return Response.json({ ok: true });
      case "setSecret":
        await setSecret(id, body.name ?? "", body.value ?? "");
        return Response.json({ ok: true });
      case "deleteSecret":
        await deleteSecret(id, body.name ?? "");
        return Response.json({ ok: true });
      case "policy":
        await setPolicy(id, body.table ?? "", { read: body.read ?? "public", write: body.write ?? "authenticated" });
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof CloudError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
