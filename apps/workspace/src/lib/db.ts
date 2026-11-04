import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const g = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  g.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 5), idleTimeoutMillis: 10_000 }),
    log: ["error"],
  });

g.prisma = db;
