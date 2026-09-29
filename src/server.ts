import "dotenv/config";
import http from "node:http";
import { prisma } from "./lib/prisma.js";
import { config } from "./config.js";
import { z } from "zod";
import { Prisma } from "@prisma/client";

// ─── Zod Schemas ───────────────────────────────────────────────────────────────

const CreateJobSchema = z.object({
  type: z.string().min(1, "type is required"),
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1, "idempotencyKey is required"),
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────────

async function handleCreateJob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await parseBody(req);
  const parsed = CreateJobSchema.safeParse(raw);

  if (!parsed.success) {
    json(res, 400, { error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { type, payload, idempotencyKey } = parsed.data;

  try {
    const job = await prisma.job.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        idempotencyKey,
        maxAttempts: config.retry.maxAttempts,
      },
    });
    json(res, 202, job);
  } catch (err) {
    // Prisma unique-constraint violation → return existing job
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.job.findUnique({
        where: { idempotencyKey },
      });
      json(res, 200, existing);
      return;
    }
    throw err;
  }
}

async function handleGetJob(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      lastError: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });

  if (!job) {
    json(res, 404, { error: "Job not found" });
    return;
  }
  json(res, 200, job);
}

async function handleGetDeadJobs(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: { status: "dead" },
    orderBy: { updatedAt: "desc" },
  });
  json(res, 200, jobs);
}

async function handleRetryJob(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id } });

  if (!job) {
    json(res, 404, { error: "Job not found" });
    return;
  }
  if (job.status !== "dead") {
    json(res, 409, { error: `Cannot retry a job with status "${job.status}". Only dead jobs can be retried.` });
    return;
  }

  const updated = await prisma.job.update({
    where: { id },
    data: {
      status: "pending",
      attempts: 0,
      lastError: null,
      runAt: new Date(),
      startedAt: null,
      finishedAt: null,
    },
  });
  json(res, 200, updated);
}

// ─── Router ────────────────────────────────────────────────────────────────────

async function router(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  try {
    // POST /api/jobs
    if (method === "POST" && path === "/api/jobs") {
      await handleCreateJob(req, res);
      return;
    }

    // GET /api/jobs/dead  (must come before :id to avoid "dead" being parsed as id)
    if (method === "GET" && path === "/api/jobs/dead") {
      await handleGetDeadJobs(req, res);
      return;
    }

    // GET /api/jobs/:id
    const getJobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (method === "GET" && getJobMatch?.[1]) {
      await handleGetJob(req, res, getJobMatch[1]);
      return;
    }

    // POST /api/jobs/:id/retry
    const retryMatch = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (method === "POST" && retryMatch?.[1]) {
      await handleRetryJob(req, res, retryMatch[1]);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("Unhandled error:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  void router(req, res);
});

server.listen(config.server.port, () => {
  console.log(`🚀 API server listening on http://localhost:${config.server.port}`);
});
