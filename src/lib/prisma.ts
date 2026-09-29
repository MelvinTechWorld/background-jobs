import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Singleton PrismaClient — one connection pool shared across the process.
 *
 * Prisma v7 requires a driver adapter instead of a built-in engine.
 * We use `@prisma/adapter-pg` backed by the `pg` Pool so we get
 * real connection pooling and control over pool size.
 *
 * In development with hot-reload (tsx --watch), the global stash prevents
 * leaking connections on every file change.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}
