import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 takes the connection through a driver adapter rather than a url in
// the schema, so the pool is constructed here.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // The local Prisma Postgres server (PGlite under `prisma dev`) closes idle
    // connections and is single-threaded: concurrent connections intermittently
    // return "Connection terminated unexpectedly", P2023 inconsistent column
    // data, or an empty session lookup. One connection serialises access and
    // removes all three. Real Postgres should raise DB_POOL_MAX. The
    // query-string options in DATABASE_URL are for Prisma's old engine and
    // node-postgres ignores them, so the pool is configured explicitly.
    adapter: new PrismaPg({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 1),
      idleTimeoutMillis: 1_000,
    }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
