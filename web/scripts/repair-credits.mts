import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Undo double-charges caused by builds being retried after a worker died.
 * Keeps the first GENERATION charge per message and refunds the rest.
 */
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

  const entries = await db.creditEntry.findMany({
    where: { reason: "GENERATION" },
    orderBy: { createdAt: "asc" },
  });

  const seen = new Set<string>();
  const dupes = entries.filter((e) => {
    const k = e.messageId ?? e.id;
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });

  let refunded = 0;
  for (const d of dupes) {
    refunded += Math.abs(d.delta);
    await db.creditEntry.delete({ where: { id: d.id } });
  }

  const ws = await db.workspace.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  // Re-derive the balance from the surviving ledger, floored at zero.
  const agg = await db.creditEntry.aggregate({
    where: { workspaceId: ws.id },
    _sum: { delta: true },
  });
  const granted = 500; // seeded starting balance
  const derived = Math.max(0, granted + (agg._sum.delta ?? 0));

  await db.workspace.update({
    where: { id: ws.id },
    data: { creditBalance: derived },
  });

  console.log(`removed ${dupes.length} duplicate charges worth ${refunded} credits`);
  console.log(`balance: ${ws.creditBalance} -> ${derived}`);
  await db.$disconnect();
}
main();
