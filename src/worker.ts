import "dotenv/config";
import { prisma } from "./lib/prisma.js";
import { config } from "./config.js";
import { type Job, Prisma } from "@prisma/client";

let isShuttingDown = false;
let activeJobsCount = 0;

// Simulate work
async function executeWork(job: Job) {
  const payload = (job.payload as Record<string, unknown>) || {};
  
  // Idempotency check logging
  console.log(`[WORKER] Executing job ${job.id} (type: ${job.type}, idempotencyKey: ${job.idempotencyKey})`);

  if (payload.simulateHang === true) {
    console.log(`[WORKER] Simulated hang for job ${job.id}. Hanging indefinitely...`);
    await new Promise(() => {}); // hang forever
  }

  // simulate artificial delay 1.5s to 2s
  const delay = Math.floor(Math.random() * 501) + 1500;
  await new Promise(res => setTimeout(res, delay));

  if (payload.simulateFailure === true) {
    throw new Error("Simulated upstream provider failure");
  }

  console.log(`[WORKER] Job ${job.id} completed successfully after ${delay}ms`);
}

async function processJob(job: Job) {
  activeJobsCount++;
  try {
    await executeWork(job);
    
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        finishedAt: new Date(),
      }
    });
  } catch (error) {
    const attempts = job.attempts + 1;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (attempts >= job.maxAttempts) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "dead",
          attempts,
          lastError: errorMessage,
          finishedAt: new Date(),
        }
      });
      console.log(`[DEAD] Job ${job.id} exhausted retries (${attempts}/${job.maxAttempts}). Moved to dead letter queue.`);
    } else {
      const delayMs = config.retry.baseDelayMs * Math.pow(2, attempts) + Math.floor(Math.random() * config.retry.jitterMaxMs);
      const runAt = new Date(Date.now() + delayMs);
      
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "pending",
          attempts,
          lastError: errorMessage,
          finishedAt: new Date(),
          runAt,
          startedAt: null,
        }
      });
      console.log(`[RETRY] Job ${job.id} attempt ${attempts} failed. Rescheduling for ${runAt.toISOString()} (delay: ${delayMs}ms)`);
    }
  } finally {
    activeJobsCount--;
  }
}

async function poll() {
  if (isShuttingDown) return;

  if (activeJobsCount >= config.worker.concurrency) {
    setTimeout(poll, config.worker.pollIntervalMs);
    return;
  }

  try {
    // Atomic Job Claim using Postgres FOR UPDATE SKIP LOCKED
    const jobs = await prisma.$queryRaw<Job[]>`
      UPDATE "Job"
      SET status = 'processing'::"JobStatus", "startedAt" = NOW()
      WHERE id = (
        SELECT id FROM "Job"
        WHERE status = 'pending'::"JobStatus" AND "runAt" <= NOW()
        ORDER BY "runAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *;
    `;

    const job = jobs[0];
    if (job) {
      // Background execution so we can continue polling up to concurrency limit
      processJob(job).catch(err => {
        console.error(`[WORKER] Unexpected error processing job ${job.id}:`, err);
      });
      
      // Poll immediately if we found a job, up to the concurrency limit
      setImmediate(poll);
    } else {
      setTimeout(poll, config.worker.pollIntervalMs);
    }
  } catch (error) {
    console.error("[WORKER] Error polling for jobs:", error);
    setTimeout(poll, config.worker.pollIntervalMs);
  }
}

async function stuckJobSweeper() {
  if (isShuttingDown) return;
  
  try {
    const timeoutThreshold = new Date(Date.now() - config.worker.stuckJobTimeoutMs);
    
    const stuckJobs = await prisma.job.findMany({
      where: {
        status: "processing",
        startedAt: {
          lte: timeoutThreshold
        }
      }
    });

    for (const job of stuckJobs) {
      const attempts = job.attempts + 1;
      const lastError = "Job timed out in processing state (recovered by sweep)";
      
      if (attempts >= job.maxAttempts) {
         await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "dead",
            attempts,
            lastError,
            finishedAt: new Date(),
          }
        });
        console.log(`[DEAD] Job ${job.id} exhausted retries after timeout. Moved to dead letter queue.`);
      } else {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "pending",
            attempts,
            lastError,
            startedAt: null,
            runAt: new Date(),
          }
        });
        console.log(`[SWEEP] Recovered stuck job ${job.id}`);
      }
    }
  } catch (error) {
    console.error("[WORKER] Error sweeping stuck jobs:", error);
  } finally {
    // Schedule next sweep every 10 seconds
    setTimeout(stuckJobSweeper, 10000);
  }
}

async function shutdown(signal: string) {
  console.log(`\nReceived ${signal}. Gracefully shutting down worker...`);
  isShuttingDown = true;
  
  let attempts = 0;
  while (activeJobsCount > 0 && attempts < 30) {
    console.log(`Waiting for ${activeJobsCount} active jobs to finish...`);
    await new Promise(res => setTimeout(res, 1000));
    attempts++;
  }
  
  if (activeJobsCount > 0) {
    console.warn(`[WARNING] Forcing shutdown with ${activeJobsCount} active jobs remaining.`);
  } else {
    console.log("All active jobs finished.");
  }

  await prisma.$disconnect();
  console.log("Worker shut down successfully.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start worker loop
console.log("⚙️ Worker process started.");
console.log(`Concurrency Limit: ${config.worker.concurrency}`);
console.log(`Poll Interval: ${config.worker.pollIntervalMs}ms`);

poll();
stuckJobSweeper();
