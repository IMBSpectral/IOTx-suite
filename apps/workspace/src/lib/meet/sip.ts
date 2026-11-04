import crypto from "node:crypto";
import type { Meeting } from "@prisma/client";
import { SipClient } from "livekit-server-sdk";
import { db } from "../db";
import { LIVEKIT_URL, roomName } from "./livekit";

/**
 * Phone dial-in through LiveKit SIP (partial: needs a SIP service and a paid
 * trunk). Every meeting gets a numeric meeting ID and a PIN. When SIP is set
 * up (LIVEKIT_SIP_TRUNK_ID from scripts/meet-sip-setup.mts, plus
 * LIVEKIT_SIP_NUMBERS to show), the meeting's room gets a "direct" dispatch
 * rule on that trunk whose PIN is the meeting ID followed by the PIN, so one
 * phone number serves every meeting: callers dial in, enter both and press #.
 *
 * Without that config nothing is created and no dial-in details are shown.
 * Encrypted meetings never get dial-in (a phone line can't decrypt).
 */

export type SipConfig = { trunkId: string; numbers: string[] };

export function sipConfig(): SipConfig | null {
  if (process.env.LIVEKIT_SIP_ENABLED === "0") return null;
  const trunkId = (process.env.LIVEKIT_SIP_TRUNK_ID ?? "").trim();
  const numbers = (process.env.LIVEKIT_SIP_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!trunkId || !numbers.length) return null;
  return { trunkId, numbers };
}

const digits = (n: number) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join("");

/** A 10-digit meeting ID (no leading zero) and a 6-digit PIN, unique among meetings. */
export async function newDialIn() {
  for (let i = 0; i < 8; i++) {
    const id = `${1 + (crypto.randomBytes(1)[0] % 9)}${digits(9)}`;
    if (!(await db.meeting.findFirst({ where: { dialInId: id }, select: { id: true } }))) return { dialInId: id, dialInPin: digits(6) };
  }
  throw new Error("Couldn't make a dial-in ID.");
}

export const formatDialInId = (id: string) => id.replace(/^(\d{3})(\d{3})(\d+)$/, "$1 $2 $3");

/** Dial-in details for people in the meeting (null when SIP isn't set up, or the meeting is encrypted). */
export function dialInInfo(m: Meeting) {
  const cfg = sipConfig();
  if (!cfg || m.e2ee || !m.dialInId || !m.dialInPin) return null;
  return {
    numbers: cfg.numbers,
    meetingId: formatDialInId(m.dialInId),
    pin: m.dialInPin,
    // One tap on a phone: the number, a pause, then ID + PIN + #.
    oneTap: cfg.numbers.map((n) => `${n.replace(/[^\d+]/g, "")},,${m.dialInId}${m.dialInPin}#`),
  };
}

/** The dial-in lines for an invitation (empty when there's no dial-in). */
export function dialInText(m: Meeting) {
  const d = dialInInfo(m);
  if (!d) return "";
  return ["Join by phone:", ...d.numbers.map((n) => `  ${n}`), `Meeting ID: ${d.meetingId}`, `PIN: ${d.pin}`, "Dial the number, enter the meeting ID and the PIN, then press #."].join("\n");
}

const httpUrl = () => LIVEKIT_URL.replace(/^ws(s?):\/\//, "http$1://");
function sip() {
  const key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) return null;
  return new SipClient(httpUrl(), key, secret);
}

/** Make sure the meeting's room has its dispatch rule (when SIP is set up). Never throws. */
export async function ensureDialRule(m: Meeting) {
  const cfg = sipConfig();
  const client = sip();
  if (!cfg || !client || m.e2ee || !m.dialInId || !m.dialInPin || m.dialInRuleId) return null;
  try {
    const rule = await client.createSipDispatchRule(
      { type: "direct", roomName: roomName(m.id), pin: `${m.dialInId}${m.dialInPin}` },
      { name: `meet_${m.id}`, trunkIds: [cfg.trunkId], hidePhoneNumber: true, attributes: { "iotx.meeting": m.code } },
    );
    await db.meeting.update({ where: { id: m.id }, data: { dialInRuleId: rule.sipDispatchRuleId } });
    return rule.sipDispatchRuleId;
  } catch (e) {
    console.error("[meet] sip dispatch rule", (e as Error).message);
    return null;
  }
}

/** Remove the meeting's dispatch rule (encryption turned on, or the meeting deleted). Never throws. */
export async function dropDialRule(m: Meeting) {
  if (!m.dialInRuleId) return;
  const client = sip();
  if (client) await client.deleteSipDispatchRule(m.dialInRuleId).catch((e) => console.error("[meet] sip rule delete", (e as Error).message));
  await db.meeting.update({ where: { id: m.id }, data: { dialInRuleId: null } });
}
