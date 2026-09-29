/**
 * seed-all-statuses.ts
 *
 * One-off helper that upserts one job per status so the database
 * table shows all 5 statuses simultaneously for evidence capture.
 *
 * Usage:  npm run seed:statuses
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

const now = new Date();
const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

const seeds = [
  {
    idempotencyKey: "seed-status-pending",
    type: "seed.evidence",
    payload: { description: "Seed job — pending status" },
    status: "pending" as const,
    attempts: 0,
    maxAttempts: 3,
    runAt: oneHourFromNow,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  },
  {
    idempotencyKey: "seed-status-processing",
    type: "seed.evidence",
    payload: { description: "Seed job — processing status" },
    status: "processing" as const,
    attempts: 1,
    maxAttempts: 3,
    runAt: now,
    startedAt: now,
    finishedAt: null,
    lastError: null,
  },
  {
    idempotencyKey: "seed-status-failed",
    type: "seed.evidence",
    payload: { description: "Seed job — failed status" },
    status: "failed" as const,
    attempts: 1,
    maxAttempts: 3,
    runAt: oneHourFromNow,
    startedAt: null,
    finishedAt: null,
    lastError: "Simulated network timeout",
  },
  {
    idempotencyKey: "seed-status-dead",
    type: "seed.evidence",
    payload: { description: "Seed job — dead status" },
    status: "dead" as const,
    attempts: 3,
    maxAttempts: 3,
    runAt: now,
    startedAt: null,
    finishedAt: now,
    lastError: "Max attempts exceeded",
  },
  {
    idempotencyKey: "seed-status-succeeded",
    type: "seed.evidence",
    payload: { description: "Seed job — succeeded status" },
    status: "succeeded" as const,
    attempts: 1,
    maxAttempts: 3,
    runAt: now,
    startedAt: now,
    finishedAt: now,
    lastError: null,
  },
];

async function main() {
  console.log("🌱 Seeding one job per status...\n");

  for (const seed of seeds) {
    const job = await prisma.job.upsert({
      where: { idempotencyKey: seed.idempotencyKey },
      create: seed,
      update: {
        status: seed.status,
        attempts: seed.attempts,
        maxAttempts: seed.maxAttempts,
        runAt: seed.runAt,
        startedAt: seed.startedAt,
        finishedAt: seed.finishedAt,
        lastError: seed.lastError,
      },
    });
    console.log(`  ✅  ${seed.status.padEnd(12)} → ${job.id}`);
  }

  console.log("\n🎉 All 5 statuses seeded. Query the table to verify.");
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
