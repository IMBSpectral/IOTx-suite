import { cloudKey, requireProjectPerm } from "@/lib/iotx/permissions";
import { getBrand } from "@/lib/brand";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { CloudError, cloudEngine, cloudUrl, getCloud, listTables } from "@/lib/cloud";
import { isSqlError } from "@/lib/cloud-db";
import { moveToPostgres } from "@/lib/cloud-move";
import { envDataId } from "@/lib/cloud-envs";
import { cloudUsage } from "@/lib/cloud-usage";
import { cancelRun, decide, getRun, listRuns, listWorkflows, retryRun, sendEvent, startRun } from "@/lib/cloud-workflows";
import { deployFunctions, functionSource, functionStats, functionsState, invokeFunction, readInvocations } from "@/lib/cloud-functions";
import { authSettings, setAuthSettings } from "@/lib/cloud-auth";
import { aiCreditsThisMonth, readAiRuns, setAiSettings } from "@/lib/cloud-ai-log";
import { stopFunctions } from "@/lib/cloud-functions";
import { destroyCloud } from "@/lib/cloud";
import { db } from "@/lib/db";
import { createJob, deleteJob, jobRuns, jobSummary, runJob, updateJob } from "@/lib/cloud-jobs";
import {
  bucketSummary,
  createBucket,
  deleteBucket,
  listFiles,
  MAX_FILE_BYTES,
  putFile,
  readFile,
  removeFile,
  signedUrl,
  storageUsed,
} from "@/lib/cloud-storage";
import {
  browseRows,
  createBackup,
  createUser,
  deleteBackup,
  deleteRow,
  deleteUser,
  exportDatabase,
  exportFormat,
  insertRow,
  listBackups,
  readLogs,
  restoreBackup,
  runSql,
  searchUsers,
  setUserPassword,
  updateRow,
} from "@/lib/cloud-admin";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The Cloud manager (people who can edit the project only):
 *   GET ?view=users&q= · rows&table=&offset= · logs&q=&errors=1 · backups · export ·
 *       storage · files&bucket=&prefix= · file&bucket=&path= ·
 *       functions · fnLogs&name=&errors=1 · fnSource&name= · jobs · jobRuns&job= ·
 *       settings · aiRuns&errors=1
 */
async function cloudOrThrow(id: string) {
  const cfg = await getCloud(id);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  return cfg;
}

async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  const url = new URL(req.url);
  const q = url.searchParams;
  // Test (default) or Live: which database the data views read.
  const d = await envDataId(id, q.get("env"));
  try {
    await requireProjectPerm(user.id, id, cloudKey(q.get("view"), true));
    switch (q.get("view")) {
      case "users":
        return Response.json({
          users: await searchUsers(d, q.get("q") ?? ""),
        });
      case "rows":
        return Response.json(
          await browseRows(d, q.get("table") ?? "", {
            offset: Number(q.get("offset") ?? 0),
          }),
        );
      case "logs":
        return Response.json({
          logs: await readLogs(id, {
            q: q.get("q") ?? "",
            errorsOnly: q.get("errors") === "1",
          }),
        });
      case "backups":
        return Response.json({ backups: await listBackups(d) });
      case "storage": {
        const cfg = await cloudOrThrow(id);
        return Response.json({ buckets: await bucketSummary(id, cfg), used: await storageUsed(id), maxFileBytes: MAX_FILE_BYTES });
      }
      case "files":
        return Response.json({
          files: await listFiles(id, await cloudOrThrow(id), q.get("bucket") ?? "", null, {
            prefix: q.get("prefix") ?? "",
            admin: true,
            limit: 500,
          }),
        });
      case "workflows":
        await cloudOrThrow(id);
        return Response.json({ workflows: await listWorkflows(id), runs: await listRuns(d, q.get("workflow") ?? undefined) });
      case "run":
        await cloudOrThrow(id);
        return Response.json(await getRun(d, q.get("run") ?? ""));
      case "usage":
        await cloudOrThrow(id);
        return Response.json(await cloudUsage(id));
      case "tables":
        await cloudOrThrow(id);
        return Response.json({ tables: await listTables(d) });
      case "settings": {
        const cfg = await cloudOrThrow(id);
        return Response.json({
          auth: authSettings(cfg),
          ai: { enabled: cfg.ai?.enabled !== false, logBodies: cfg.ai?.logBodies === true, creditLimit: cfg.ai?.creditLimit ?? null },
          aiUsage: await aiCreditsThisMonth(id),
          engine: await cloudEngine(id),
          movedToPostgres: cfg.movedToPostgres ?? null,
          projectName: project.name,
        });
      }
      case "aiRuns":
        await cloudOrThrow(id);
        return Response.json({ runs: await readAiRuns(id, { errorsOnly: q.get("errors") === "1" }) });
      case "functions": {
        const cfg = await cloudOrThrow(id);
        const st = functionsState(cfg);
        return Response.json({
          deployedAt: st?.deployedAt ?? null,
          deploys: st?.history ?? [],
          baseUrl: `${cloudUrl(id)}/functions`,
          functions: await functionStats(id, st?.names ?? []),
        });
      }
      case "fnLogs":
        await cloudOrThrow(id);
        return Response.json({ logs: await readInvocations(id, { name: q.get("name") ?? "", errorsOnly: q.get("errors") === "1" }) });
      case "fnSource":
        return Response.json({ source: await functionSource(id, q.get("name") ?? "") });
      case "jobs":
        return Response.json({ jobs: await jobSummary(id, await cloudOrThrow(id)) });
      case "jobRuns":
        await cloudOrThrow(id);
        return Response.json({ runs: await jobRuns(id, q.get("job") ?? "") });
      case "file": {
        const { file, bytes } = await readFile(id, await cloudOrThrow(id), q.get("bucket") ?? "", q.get("path") ?? "", null, { admin: true });
        return new Response(new Uint8Array(bytes), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${file.path.split("/").pop()!.replace(/"/g, "")}"`,
            "x-content-type-options": "nosniff",
          },
        });
      }
      case "export": {
        const bytes = await exportDatabase(d);
        const format = await exportFormat(d);
        return new Response(new Uint8Array(bytes), {
          headers: {
            "content-type": format.contentType,
            "content-disposition": `attachment; filename="${project.slug}-database.${format.extension}"`,
          },
        });
      }
      default:
        return Response.json({ error: "Unknown view" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof CloudError)
      return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/**
 * Actions: createUser {email, password?} · deleteUser {userId} · setPassword {userId, password?} ·
 * insertRow {table, row} · updateRow {table, rowid, patch} · deleteRow {table, rowid} · sql {sql} ·
 * backup · restore {backupId} · deleteBackup {backupId} ·
 * createBucket {name, access} · deleteBucket {name} · uploadFile {bucket, path, contentType, base64} ·
 * deleteFile {bucket, path} · signUrl {bucket, path, expiresIn?} ·
 * setAuth {password?, emailCode?, signups?, allowedDomains?} · setAi {logBodies?, creditLimit?} ·
 * disableCloud {confirm: project name} · deployFunctions · invokeFunction {name, method?, body?} · createJob {name, fn, schedule, timezone?, body?} ·
 * updateJob {jobId, enabled?, schedule?, timezone?, name?, body?} · deleteJob {jobId} · runJob {jobId}
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const d = await envDataId(id, typeof b.env === "string" ? b.env : null);
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const obj = (k: string) =>
    b[k] && typeof b[k] === "object" ? (b[k] as Record<string, unknown>) : {};
  try {
    await requireProjectPerm(user.id, id, cloudKey(typeof b.action === "string" ? b.action : null));
    switch (b.action) {
      case "createUser":
        return Response.json(
          await createUser(d, str("email"), str("password") || undefined),
          { status: 201 },
        );
      case "deleteUser":
        await deleteUser(d, str("userId"));
        return Response.json({ ok: true });
      case "setPassword":
        return Response.json(
          await setUserPassword(
            id,
            str("userId"),
            str("password") || undefined,
          ),
        );
      case "insertRow":
        await insertRow(d, str("table"), obj("row"));
        return Response.json({ ok: true }, { status: 201 });
      case "updateRow":
        await updateRow(d, str("table"), Number(b.rowid), obj("patch"));
        return Response.json({ ok: true });
      case "deleteRow":
        await deleteRow(d, str("table"), Number(b.rowid));
        return Response.json({ ok: true });
      case "sql":
        return Response.json(await runSql(d, str("sql")));
      case "backup":
        return Response.json(await createBackup(d), { status: 201 });
      case "emailExport": {
        // The export, as a 24-hour download link emailed to the person asking.
        if (!user.email) return Response.json({ error: "Your account has no email address." }, { status: 400 });
        const project = await db.project.findUniqueOrThrow({ where: { id }, select: { slug: true } });
        const { emailExportLink } = await import("@/lib/cloud-export-link");
        const r = await emailExportLink(id, d, project.slug, user.email);
        if (r.status === "failed") return Response.json({ error: "The export was made, but the email couldn't be sent. Use Export database instead." }, { status: 502 });
        return Response.json({ sentTo: user.email, expiresAt: r.expiresAt, delivered: r.status === "sent" });
      }
      case "restore":
        return Response.json(await restoreBackup(d, str("backupId")));
      case "deleteBackup":
        await deleteBackup(d, str("backupId"));
        return Response.json({ ok: true });
      case "createBucket":
        await cloudOrThrow(id);
        return Response.json({ buckets: await createBucket(id, str("name"), str("access") as "public") }, { status: 201 });
      case "deleteBucket":
        await deleteBucket(id, str("name"));
        return Response.json({ ok: true });
      case "uploadFile":
        return Response.json(
          await putFile(id, await cloudOrThrow(id), str("bucket"), str("path"), Buffer.from(str("base64"), "base64"), str("contentType"), null, { admin: true }),
          { status: 201 },
        );
      case "setAuth":
        await cloudOrThrow(id);
        return Response.json({ auth: await setAuthSettings(id, obj("auth")) });
      case "setAi":
        await cloudOrThrow(id);
        return Response.json({
          ai: await setAiSettings(id, {
            ...(typeof b.logBodies === "boolean" ? { logBodies: b.logBodies } : {}),
            ...(b.creditLimit !== undefined ? { creditLimit: b.creditLimit === null ? null : Number(b.creditLimit) } : {}),
          }),
        });
      case "moveToPostgres": {
        // Admins only: copies schema and data, checks row counts, keeps the SQLite files as backups.
        const ws = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: project.workspaceId } }, select: { role: true } });
        if (!ws || !["OWNER", "ADMIN"].includes(String(ws.role))) {
          return Response.json({ error: "Only workspace admins can move a database." }, { status: 403 });
        }
        return Response.json(await moveToPostgres(id));
      }
      case "disableCloud": {
        await cloudOrThrow(id);
        const p = await db.project.findUniqueOrThrow({ where: { id }, select: { name: true } });
        if (str("confirm").trim() !== p.name.trim()) {
          return Response.json({ error: "Type the project name exactly to confirm." }, { status: 400 });
        }
        // The database, its users, files, functions and jobs all go.
        await stopFunctions(id).catch(() => undefined);
        await destroyCloud(id);
        return Response.json({ ok: true });
      }
      case "startRun":
        return Response.json(await startRun(id, d, str("workflow"), b.input ?? {}), { status: 201 });
      case "approveRun":
      case "rejectRun":
        await decide(id, d, str("runId"), b.action === "approveRun", user.email ?? "an editor");
        return Response.json({ ok: true });
      case "sendEvent":
        return Response.json(await sendEvent(id, d, str("runId"), str("event"), b.data));
      case "cancelRun":
        await cancelRun(d, str("runId"));
        return Response.json({ ok: true });
      case "retryRun":
        await retryRun(id, d, str("runId"));
        return Response.json({ ok: true });
      case "deployFunctions":
        return Response.json(await deployFunctions(id), { status: 201 });
      case "invokeFunction": {
        const cfg = await cloudOrThrow(id);
        const method = str("method") || "POST";
        const res = await invokeFunction(
          id,
          cfg,
          str("name"),
          {
            method,
            url: `${cloudUrl(id)}/functions/${str("name")}`,
            headers: { "content-type": "application/json" },
            body: method === "GET" ? null : Buffer.from(str("body") || "{}"),
          },
          null,
          "test",
        );
        return Response.json({ status: res.status, contentType: res.headers["content-type"] ?? null, body: res.body.toString("utf8").slice(0, 20_000) });
      }
      case "createJob":
        return Response.json(
          await createJob(id, { name: str("name"), fn: str("fn"), schedule: str("schedule"), timezone: str("timezone") || undefined, body: str("body") || undefined }),
          { status: 201 },
        );
      case "updateJob":
        return Response.json(
          await updateJob(id, str("jobId"), {
            ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
            ...(typeof b.schedule === "string" ? { schedule: b.schedule } : {}),
            ...(typeof b.timezone === "string" ? { timezone: b.timezone } : {}),
            ...(typeof b.name === "string" ? { name: b.name } : {}),
            ...(typeof b.body === "string" ? { body: b.body } : {}),
          }),
        );
      case "deleteJob":
        await deleteJob(id, str("jobId"));
        return Response.json({ ok: true });
      case "runJob":
        return Response.json(await runJob(id, str("jobId"), true));
      case "deleteFile":
        return Response.json(await removeFile(id, await cloudOrThrow(id), str("bucket"), str("path"), null, { admin: true }));
      case "signUrl":
        return Response.json(await signedUrl(id, await cloudOrThrow(id), str("bucket"), str("path"), null, Number(b.expiresIn ?? 3600), { admin: true }));
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof CloudError)
      return Response.json({ error: e.message }, { status: e.status });
    // Database errors from the SQL editor or a row edit (SQLite or Postgres) are the user's to see.
    if (isSqlError(e))
      return Response.json({ error: (e as Error).message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
