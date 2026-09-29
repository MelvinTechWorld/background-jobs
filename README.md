# Background Jobs

A resilient, production-grade background job processing system built with **Node.js**, **TypeScript**, **Prisma ORM (v7)**, and **Neon PostgreSQL**.

> **Repository:** <https://github.com/MelvinTechWorld/background-jobs>

---

## Table of Contents

- [System Overview](#system-overview)
- [System Architecture & Lifecycle](#system-architecture--lifecycle)
- [Core Design Decisions & Trade-offs](#core-design-decisions--trade-offs)
- [API Contracts](#api-contracts)
- [Local Setup & Execution](#local-setup--execution)
- [Verification & Break-It Evidence](#verification--break-it-evidence)

---

## System Overview

The system provides a durable, at-least-once job queue backed by a PostgreSQL table. Jobs are submitted via a REST API, persisted to Neon PostgreSQL through Prisma, and processed asynchronously by a separate worker process. The design prioritises **correctness under concurrency**, **automatic retry with exponential backoff**, and **operator visibility** into every job state.

| Layer | Technology |
| --- | --- |
| Runtime | Node.js (ES Modules) |
| Language | TypeScript (strict mode) |
| ORM | Prisma v7 with `@prisma/adapter-pg` driver adapter |
| Database | Neon PostgreSQL (serverless) |
| Validation | Zod v4 |

---

## System Architecture & Lifecycle

Every job passes through exactly **five** lifecycle states, stored as a PostgreSQL enum (`JobStatus`):

| Status | Kind | Description |
| --- | --- | --- |
| `pending` | Waiting | Queued and eligible for pickup once `runAt ≤ NOW()` |
| `processing` | Active | Claimed by a worker; work is in progress |
| `succeeded` | Terminal ✅ | Work completed without error |
| `failed` | Transient ⚠️ | Work threw an error but retries remain — **will be retried** |
| `dead` | Terminal ☠️ | All retry attempts exhausted — **quarantined for human review** |

### Lifecycle Flow Diagram

```
                          ┌──────────────────────────────────────┐
                          │          Job Created (API)           │
                          └──────────────┬───────────────────────┘
                                         │
                                         ▼
                                   ┌──────────┐
                          ┌───────►│ pending  │◄──────────────────┐
                          │        └────┬─────┘                   │
                          │             │ worker claims            │
                          │             │ (FOR UPDATE SKIP LOCKED) │
                          │             ▼                          │
                          │       ┌────────────┐                  │
                          │       │ processing │                  │
                          │       └──┬─────┬───┘                  │
                          │          │     │                       │
                          │  success │     │ failure               │
                          │          │     │                       │
                          │          ▼     ▼                       │
                          │   ┌──────────┐  ┌────────┐            │
                          │   │succeeded │  │ failed │────────────┘
                          │   └──────────┘  └───┬────┘  retries remain:
                          │                     │       reset to pending
                          │                     │       with backoff delay
                          │                     │
                          │                     │ retries exhausted
                          │                     ▼
                          │               ┌──────────┐
                          │               │   dead   │
                          │               └────┬─────┘
                          │                    │ manual retry
                          └────────────────────┘  (POST /api/jobs/:id/retry)
```

### Why `failed` and `dead` Are Strictly Distinct

- **`failed`** is a **transient, retryable** state. The job hit an error but still has remaining attempts (`attempts < maxAttempts`). The worker automatically resets it to `pending` with an exponential backoff delay. No human intervention is required — the system self-heals.

- **`dead`** is a **terminal quarantine** state. The job has exhausted every retry attempt (`attempts >= maxAttempts`). It is removed from the processing pipeline entirely and will **never be automatically retried**. An operator must inspect the `lastError`, diagnose the root cause, and explicitly call `POST /api/jobs/:id/retry` to resurrect it. This separation prevents poison-pill jobs from consuming worker capacity indefinitely and gives operators a clean dead-letter queue to audit.

---

## Core Design Decisions & Trade-offs

### 1. Atomic Claims with `FOR UPDATE SKIP LOCKED`

**Problem:** Prisma's standard query API (e.g., `findFirst` + `update`) cannot atomically claim a job. Between the `SELECT` and the `UPDATE`, a second worker can read the same row — causing **duplicate processing**.

**Solution:** We bypass Prisma's query builder and use `prisma.$queryRaw` with a single SQL statement that selects and updates atomically:

```sql
-- src/worker.ts, lines 91-102
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
```

**Key details:**

- `FOR UPDATE` acquires a row-level lock on the selected row inside the subquery.
- `SKIP LOCKED` tells concurrent workers to silently skip any already-locked rows instead of blocking. This is the critical piece — without it, workers would queue behind each other on the same row.
- The outer `UPDATE ... WHERE id = (subquery)` promotes the lock into a write in a single round-trip, making the claim **atomic**: no worker can ever see a job that another worker has already locked.

**Trade-off:** We sacrifice Prisma's type-safe query builder for this single query, but gain a guarantee that Prisma's standard API simply cannot express.

### 2. Exponential Backoff with Jitter

**Problem:** When a downstream service fails (e.g., an email provider returns 503), all failed jobs would retry at the same wall-clock time. This creates a **thundering herd** — a burst of retries that can re-overwhelm the recovering service and cause cascading failures.

**Solution:** Each retry delay is computed with **exponential backoff** plus **random uniform jitter** (`src/worker.ts`, line 60):

```typescript
const delayMs =
  config.retry.baseDelayMs * Math.pow(2, attempts)
  + Math.floor(Math.random() * config.retry.jitterMaxMs);
```

With `baseDelayMs = 1000` and `jitterMaxMs = 500` (defined in `src/config.ts`):

| Attempt | Base Delay | Jitter Range | Total Delay Range |
| --- | --- | --- | --- |
| 1 | 2 000 ms | 0–500 ms | 2 000 – 2 500 ms |
| 2 | 4 000 ms | 0–500 ms | 4 000 – 4 500 ms |
| 3 | 8 000 ms | 0–500 ms | 8 000 – 8 500 ms |

The random jitter component (`Math.random() * jitterMaxMs`) ensures that even if 100 jobs fail simultaneously, their retry times are **uniformly spread** across a 500 ms window at each tier, preventing synchronized spikes on the downstream service.

### 3. Concurrency Capping

**Problem:** An unbounded worker could spawn thousands of in-flight promises, exhausting memory, file descriptors, and database connections.

**Solution:** The worker tracks `activeJobsCount` and checks it against `config.worker.concurrency` (set to **5** in `src/config.ts`, line 15) before every poll:

```typescript
// src/worker.ts, lines 83-87
if (activeJobsCount >= config.worker.concurrency) {
  setTimeout(poll, config.worker.pollIntervalMs);
  return;   // skip this poll cycle — all slots are full
}
```

When a job completes (success or failure), `activeJobsCount` is decremented in a `finally` block, opening a slot for the next poll cycle. This creates a **natural backpressure** mechanism: the worker never claims more work than it can handle.

### 4. Stuck-Job Recovery (Sweeper)

**Problem:** If a worker process crashes (e.g., `kill -9`, OOM) after claiming a job but before finishing it, the job is stranded in `processing` forever — invisible to other workers.

**Solution:** A background sweeper runs every **10 seconds** (`src/worker.ts`, line 170) and scans for any job that has been `processing` for longer than `stuckJobTimeoutMs` (**60 000 ms** — defined in `src/config.ts`, line 19):

```typescript
// src/worker.ts, lines 126-134
const timeoutThreshold = new Date(Date.now() - config.worker.stuckJobTimeoutMs);

const stuckJobs = await prisma.job.findMany({
  where: {
    status: "processing",
    startedAt: { lte: timeoutThreshold },
  },
});
```

For each stuck job found:

- If **retries remain** → reset to `pending` with `runAt = NOW()` so it is immediately re-eligible.
- If **retries exhausted** → move to `dead` with a descriptive `lastError` ("Job timed out in processing state (recovered by sweep)").

**Trade-off:** The 60-second timeout must be longer than the longest legitimate job execution time. If a job genuinely takes 90 seconds, the sweeper will incorrectly reclaim it. The value is tunable in `src/config.ts`.

---

## API Contracts

All endpoints return `Content-Type: application/json`.

### `POST /api/jobs` — Enqueue a Job

**Request Body:**

```json
{
  "type": "email.send",
  "payload": { "to": "user@example.com", "subject": "Hello" },
  "idempotencyKey": "order-confirm-abc123"
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Job type identifier |
| `payload` | `object` | ❌ | Arbitrary JSON data (defaults to `{}`) |
| `idempotencyKey` | `string` | ✅ | Unique key preventing duplicate enqueue |

**Responses:**

| Status | Condition | Body |
| --- | --- | --- |
| `202 Accepted` | New job created | Full `Job` object |
| `200 OK` | Duplicate `idempotencyKey` (Prisma error `P2002` caught) | Existing `Job` object |
| `400 Bad Request` | Zod validation failure | `{ "error": "Validation failed", "issues": [...] }` |

**Idempotency mechanism:** The `idempotencyKey` column has a `@unique` constraint. On a duplicate insert, Prisma throws a `PrismaClientKnownRequestError` with code `P2002`. The handler catches this specific error, looks up the existing job by `idempotencyKey`, and returns it with `200 OK` — making the endpoint safe to call multiple times with the same key.

---

### `GET /api/jobs/:id` — Get Job Status

**Response (`200 OK`):**

```json
{
  "id": "clx1abc...",
  "type": "email.send",
  "status": "succeeded",
  "attempts": 1,
  "maxAttempts": 3,
  "lastError": null,
  "startedAt": "2026-09-28T...",
  "finishedAt": "2026-09-28T...",
  "createdAt": "2026-09-28T..."
}
```

| Status | Condition | Body |
| --- | --- | --- |
| `200 OK` | Job found | Job object (selected fields) |
| `404 Not Found` | No job with that ID | `{ "error": "Job not found" }` |

---

### `GET /api/jobs/dead` — List Dead-Letter Jobs

Returns all jobs with `status = "dead"`, ordered by `updatedAt DESC`.

| Status | Body |
| --- | --- |
| `200 OK` | `Job[]` array (may be empty) |

---

### `POST /api/jobs/:id/retry` — Retry a Dead Job

Resets a `dead` job back to `pending` with `attempts = 0`, clearing all error and timing fields.

| Status | Condition | Body |
| --- | --- | --- |
| `200 OK` | Job was `dead` and has been reset | Updated `Job` object |
| `404 Not Found` | No job with that ID | `{ "error": "Job not found" }` |
| `409 Conflict` | Job is not in `dead` status | `{ "error": "Cannot retry a job with status \"...\". Only dead jobs can be retried." }` |

---

## Local Setup & Execution

### Prerequisites

- **Node.js** ≥ 18
- A **Neon PostgreSQL** database (or any PostgreSQL instance)

### 1. Clone the Repository

```bash
git clone https://github.com/MelvinTechWorld/background-jobs.git
cd background-jobs
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and set your database connection string:

```
DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"
```

### 4. Push the Database Schema

```bash
npx prisma db push
```

This creates the `Job` table and `JobStatus` enum in your Neon database.

### 5. Start the Server (Terminal 1)

```bash
npm run server
```

Output: `🚀 API server listening on http://localhost:3000`

### 6. Start the Worker (Terminal 2)

```bash
npm run worker
```

Output: `⚙️ Worker process started.`

### 7. Submit a Test Job

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"email.send","payload":{"to":"test@example.com"},"idempotencyKey":"test-1"}'
```

---

## Verification & Break-It Evidence

The following screenshots demonstrate all five lifecycle states and the system's resilience under adversarial conditions.

### 1. Jobs Table — All Five Statuses

Database table showing at least one job in every status (`pending`, `processing`, `failed`, `dead`, `succeeded`) simultaneously.

![Jobs Table All Statuses](./evidence/1-jobs-table-all-statuses.png)

---

### 2. Backoff Timestamps Growing

Worker logs showing exponentially increasing `runAt` delays between retry attempts, confirming the backoff + jitter formula.

![Backoff Timestamps Growing](./evidence/2-backoff-timestamps-growing.png)

---

### 3. Concurrency Cap — 50 Jobs

50 jobs submitted simultaneously; worker logs confirm no more than 5 execute concurrently at any point (`worker.concurrency = 5`).

![Concurrency Cap](./evidence/3-concurrency-cap-50-jobs.png)

---

### 4. Stuck Job Recovery

A worker is killed mid-processing. The sweeper detects the orphaned job after 60 seconds and resets it to `pending` for re-processing.

![Stuck Job Recovery](./evidence/4-stuck-job-recovery.png)

---

### 5. Dead-Letter View

A job that has exhausted all 3 retry attempts is moved to `dead` status with a final `lastError` — visible via `GET /api/jobs/dead`.

![Dead Letter View](./evidence/5-dead-letter-view.png)
