import crypto from "node:crypto";

/**
 * Server-to-server calls from IOTx apps that run as their own process
 * (apps/workspace: Calendar, Tasks, Chat). They send the shared secret in
 * `x-iotx-key`; a browser never has it. Compared in constant time.
 */
export function serviceKeyOk(req: Request) {
  const want = process.env.IOTX_SERVICE_KEY;
  const given = req.headers.get("x-iotx-key");
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const forbidden = () => Response.json({ error: "Forbidden" }, { status: 403 });
