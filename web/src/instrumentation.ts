/**
 * Runs once when the server starts (Next.js instrumentation): start the
 * build worker, the idle-container reaper and the node_modules template
 * build straight away, instead of waiting for the first request that needs
 * them. Queued builds from before a restart resume at once.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ ensureWorker }, { ensureReaper, dockerAvailable }] = await Promise.all([import("./lib/worker"), import("./lib/sandbox")]);
  ensureWorker();
  (await import("./lib/sandbox-proxy")).ensurePreviewProxy();
  if (await dockerAvailable()) {
    ensureReaper();
    // Scheduled jobs call server functions, which run in containers.
    (await import("./lib/cloud-jobs")).ensureJobs();
    (await import("./lib/mail/poller")).ensureMailPoller();
  }
}
