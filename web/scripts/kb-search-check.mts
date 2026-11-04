/** Quick look at knowledge-base ranking: npx tsx scripts/kb-search-check.mts <devToken> "<query>" ... */
import "dotenv/config";
import { db } from "../src/lib/db";
import { search, viewer } from "../src/lib/kb";
const [token, ...qs] = process.argv.slice(2);
const s = await db.session.findUnique({ where: { sessionToken: token } });
const ws = (await db.membership.findFirst({ where: { userId: s!.userId, role: "OWNER" }, orderBy: { createdAt: "asc" } }))!.workspaceId;
const v = await viewer(s!.userId, ws);
for (const q of qs) {
  const t = Date.now();
  const hits = await search(v, q, { limit: 4 });
  console.log(`== ${q}  (${Date.now() - t} ms)`);
  for (const h of hits) console.log(`  ${h.rank.toFixed(2)}  ${h.title} › ${h.heading} | ${h.text.slice(0, 80).replace(/\s+/g, " ")}`);
}
await db.$disconnect();
