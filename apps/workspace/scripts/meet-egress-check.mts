// Diagnostic: can LiveKit Egress record here?  npx tsx scripts/meet-egress-check.mts [--audio]
import fs from "node:fs";
const envOf = (f: string | URL) => Object.fromEntries(fs.readFileSync(f, "utf8").split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m![1], m![2].replace(/^"|"$/g, "")]));
import { EgressClient, RoomServiceClient, EncodedFileOutput, EncodedFileType, EgressStatus } from "livekit-server-sdk";
const env = envOf(new URL("../.env", import.meta.url));
const rooms = new RoomServiceClient("http://localhost:7880", env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
const eg = new EgressClient("http://localhost:7880", env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
const room = `egress_try_${Date.now()}`;
await rooms.createRoom({ name: room, emptyTimeout: 120 });
const audioOnly = process.argv.includes("--audio");
const info = await eg.startRoomCompositeEgress(room, new EncodedFileOutput({ fileType: audioOnly ? EncodedFileType.OGG : EncodedFileType.MP4, filepath: `/out/${room}.${audioOnly ? "ogg" : "mp4"}` }), { layout: "grid", audioOnly });
console.log("started", info.egressId, EgressStatus[info.status]);
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const [x] = await eg.listEgress({ egressId: info.egressId });
  console.log(i, EgressStatus[x.status], x.error);
  if (x.status === EgressStatus.EGRESS_ACTIVE && i > 5) break;
  if (x.status >= 3) process.exit(0);
}
const s = await eg.stopEgress(info.egressId);
console.log("stop", EgressStatus[s.status]);
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const [x] = await eg.listEgress({ egressId: info.egressId });
  console.log("after", EgressStatus[x.status], x.error, x.fileResults?.[0]?.size);
  if (x.status >= 3) break;
}
