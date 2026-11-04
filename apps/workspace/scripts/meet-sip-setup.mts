/**
 * IOTx Meet phone dial-in: set up the LiveKit SIP inbound trunk (partial
 * feature: needs the LiveKit SIP service running next to LiveKit, and a paid
 * SIP trunk / phone number from a provider such as Twilio, Telnyx or Plivo).
 *
 *   npx tsx scripts/meet-sip-setup.mts            plan only (prints what it would do)
 *   npx tsx scripts/meet-sip-setup.mts --apply    create the inbound trunk; prints LIVEKIT_SIP_TRUNK_ID for .env
 *   npx tsx scripts/meet-sip-setup.mts --list     trunks and Meet dispatch rules on this LiveKit
 *   npx tsx scripts/meet-sip-setup.mts --remove <trunkId>   delete that trunk and every meet_ dispatch rule on it
 *   npx tsx scripts/meet-sip-setup.mts --self-test          create a throwaway trunk + PIN rule against LiveKit, check, delete
 *
 * Reads apps/workspace/.env (or the process environment):
 *   LIVEKIT_SIP_NUMBERS            the trunk's phone numbers, comma-separated, e.g. "+14155550100" (also shown to callers)
 *   LIVEKIT_SIP_ALLOWED_ADDRESSES  optional: the provider's signalling IPs/CIDRs
 *   LIVEKIT_SIP_AUTH_USER / LIVEKIT_SIP_AUTH_PASS  optional: digest auth the provider sends
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 * After --apply, add LIVEKIT_SIP_TRUNK_ID=<id> to .env and restart Workspace. Each meeting's room then gets a
 * "direct" dispatch rule whose PIN is its 10-digit meeting ID followed by its 6-digit PIN (see src/lib/meet/sip.ts).
 * Secrets are never printed.
 */
import fs from "node:fs";
import path from "node:path";
import { SipClient } from "livekit-server-sdk";

const envFile = path.join(import.meta.dirname, "..", ".env");
const fileEnv: Record<string, string> = {};
if (fs.existsSync(envFile))
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) fileEnv[m[1]] = m[2].replace(/^"|"$/g, "");
  }
const env = (k: string) => process.env[k] ?? fileEnv[k] ?? "";
const list = (k: string) => env(k).split(",").map((s) => s.trim()).filter(Boolean);

const url = (env("LIVEKIT_URL") || "ws://localhost:7880").replace(/^ws(s?):\/\//, "http$1://");
if (!env("LIVEKIT_API_KEY") || !env("LIVEKIT_API_SECRET")) {
  console.error("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are missing.");
  process.exit(2);
}
const sip = new SipClient(url, env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"));
const args = process.argv.slice(2);

async function listAll() {
  const trunks = await sip.listSipInboundTrunk();
  const rules = await sip.listSipDispatchRule();
  console.log(`Inbound trunks (${trunks.length}):`);
  for (const t of trunks) console.log(`  ${t.sipTrunkId}  ${t.name}  numbers=${t.numbers.join(",")}`);
  const meet = rules.filter((r) => r.name.startsWith("meet_"));
  console.log(`Meet dispatch rules: ${meet.length} (of ${rules.length})`);
  for (const r of meet.slice(0, 50)) console.log(`  ${r.sipDispatchRuleId}  ${r.name}  trunks=${r.trunkIds.join(",")}`);
}

if (args.includes("--list")) {
  await listAll();
} else if (args.includes("--remove")) {
  const id = args[args.indexOf("--remove") + 1];
  if (!id) throw new Error("--remove needs a trunk id");
  for (const r of await sip.listSipDispatchRule()) if (r.name.startsWith("meet_") && r.trunkIds.includes(id)) await sip.deleteSipDispatchRule(r.sipDispatchRuleId);
  await sip.deleteSipTrunk(id);
  console.log(`Removed trunk ${id} and its Meet dispatch rules. Remove LIVEKIT_SIP_TRUNK_ID from .env.`);
} else if (args.includes("--self-test")) {
  // Checks the API calls Meet makes, with a fake number. No calls are placed.
  const t = await sip.createSipInboundTrunk("iotx-meet-selftest", ["+15550000001"], { allowedAddresses: ["192.0.2.0/24"] });
  const rule = await sip.createSipDispatchRule({ type: "direct", roomName: "meet_selftest", pin: "1234567890123456" }, { name: "meet_selftest", trunkIds: [t.sipTrunkId], hidePhoneNumber: true });
  const found = (await sip.listSipDispatchRule()).some((r) => r.sipDispatchRuleId === rule.sipDispatchRuleId);
  await sip.deleteSipDispatchRule(rule.sipDispatchRuleId);
  await sip.deleteSipTrunk(t.sipTrunkId);
  console.log(found ? "SELFTEST OK trunk and PIN dispatch rule created, listed and deleted" : "SELFTEST FAIL rule not listed");
  process.exit(found ? 0 : 1);
} else {
  const numbers = list("LIVEKIT_SIP_NUMBERS");
  const allowed = list("LIVEKIT_SIP_ALLOWED_ADDRESSES");
  const user = env("LIVEKIT_SIP_AUTH_USER");
  const pass = env("LIVEKIT_SIP_AUTH_PASS");
  if (!numbers.length) {
    console.log("Dial-in is not configured: set LIVEKIT_SIP_NUMBERS (the trunk's phone numbers) in .env first.");
    console.log("You also need: the LiveKit SIP service (livekit/sip) running with UDP 5060 and an RTP port range open,");
    console.log("and a SIP trunk from a provider pointing at this server. See apps/workspace/livekit/README.md.");
    process.exit(args.includes("--apply") ? 1 : 0);
  }
  console.log(`Plan: inbound trunk "iotx-meet" for ${numbers.join(", ")}${allowed.length ? `, allowed from ${allowed.join(", ")}` : ""}${user ? ", with digest auth" : ""}.`);
  if (!args.includes("--apply")) {
    console.log("Run again with --apply to create it.");
    process.exit(0);
  }
  const existing = (await sip.listSipInboundTrunk()).find((t) => t.name === "iotx-meet");
  const trunk = existing ?? (await sip.createSipInboundTrunk("iotx-meet", numbers, { allowedAddresses: allowed.length ? allowed : undefined, authUsername: user || undefined, authPassword: pass || undefined, krispEnabled: false }));
  console.log(`${existing ? "Trunk already exists" : "Created trunk"}. Add this line to apps/workspace/.env and restart Workspace:`);
  console.log(`LIVEKIT_SIP_TRUNK_ID=${trunk.sipTrunkId}`);
}
