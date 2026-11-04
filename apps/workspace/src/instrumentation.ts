export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.WORKSPACE_JOBS !== "off") {
    const { startJobs } = await import("./lib/jobs");
    startJobs();
  }
}
