import { AccessToken, EgressClient, RoomServiceClient, WebhookReceiver, type VideoGrant } from "livekit-server-sdk";
import { HttpError } from "../auth";

/**
 * LiveKit (self-hosted SFU) for IOTx Meet. The server talks to LiveKit at
 * LIVEKIT_URL (ws://localhost:7880 locally); browsers connect to
 * LIVEKIT_PUBLIC_URL (wss://<domain>/livekit in production). The key pair
 * lives only in .env and in livekit/livekit.yaml.
 */

export const LIVEKIT_URL = (process.env.LIVEKIT_URL ?? "ws://localhost:7880").replace(/\/$/, "");
export const LIVEKIT_PUBLIC_URL = (process.env.LIVEKIT_PUBLIC_URL ?? LIVEKIT_URL).replace(/\/$/, "");
const httpUrl = () => LIVEKIT_URL.replace(/^ws(s?):\/\//, "http$1://");

function creds() {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) throw new HttpError(503, "Meetings aren't set up on this server (LiveKit keys are missing).");
  return { key, secret };
}

const g = globalThis as unknown as { __lkRooms?: RoomServiceClient; __lkEgress?: EgressClient };
export function rooms() {
  const { key, secret } = creds();
  return (g.__lkRooms ??= new RoomServiceClient(httpUrl(), key, secret));
}
export function egress() {
  const { key, secret } = creds();
  return (g.__lkEgress ??= new EgressClient(httpUrl(), key, secret));
}
export function webhookReceiver() {
  const { key, secret } = creds();
  return new WebhookReceiver(key, secret);
}

/** The LiveKit room for a meeting. */
export const roomName = (meetingId: string) => `meet_${meetingId}`;
/** Breakout room n of a meeting. */
export const breakoutRoom = (meetingId: string, n: number) => `meet_${meetingId}_b${n}`;

export type MeetRole = "host" | "cohost" | "member" | "guest" | "panelist" | "attendee";

/**
 * A join token. Everyone may publish camera, mic and screen and send chat
 * data. Nobody gets roomAdmin or roomRecord: host controls and recording go
 * through our API, which checks who is asking. Nobody may change their own
 * metadata (it carries the role the UI shows).
 */
export async function joinToken(p: { room: string; identity: string; name: string; role: MeetRole; ttlSeconds?: number }) {
  // Webinar attendees watch only: no publishing, and hidden (nobody gets an entry for each of up to 1000 attendees).
  // A host brings someone on stage by changing these permissions live (see webinar.ts).
  const attendee = p.role === "attendee";
  const { key, secret } = creds();
  const at = new AccessToken(key, secret, {
    identity: p.identity,
    name: p.name,
    ttl: p.ttlSeconds ?? 15 * 60,
    metadata: JSON.stringify({ role: p.role }),
  });
  const grant: VideoGrant = {
    room: p.room,
    roomJoin: true,
    canPublish: !attendee,
    canSubscribe: true,
    canPublishData: true,
    hidden: attendee,
    canUpdateOwnMetadata: false,
    roomAdmin: false,
    roomRecord: false,
    roomCreate: false,
    roomList: false,
  };
  at.addGrant(grant);
  return at.toJwt();
}

/** Room-service calls that may fail because the room isn't running yet. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/not found|does not exist|404/i.test(msg)) return null;
    throw e;
  }
}
