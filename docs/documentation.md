# Technical Documentation — Background Jobs System

> In-depth technical report covering break-it attack scenarios, reviewer defence answers, and operational guidance.

---

## Table of Contents

- [Break-It Attack Scenarios](#break-it-attack-scenarios)
  - [Scenario 1: 50-Job Flood](#scenario-1-50-job-flood)
  - [Scenario 2: 100% Failure Run](#scenario-2-100-failure-run)
  - [Scenario 3: Mid-Job Worker Kill & Recovery](#scenario-3-mid-job-worker-kill--recovery)
  - [Scenario 4: Idempotency Key Collision](#scenario-4-idempotency-key-collision)
  - [Scenario 5: Dual-Worker Contention](#scenario-5-dual-worker-contention)
- [Reviewer Defence Questions](#reviewer-defence-questions)
- [Operational Guide: Dead-Letter Diagnosis & Manual Retries](#operational-guide-dead-letter-diagnosis--manual-retries)

---

## Break-It Attack Scenarios

### Scenario 1: 50-Job Flood

**Objective:** Verify the worker respects its concurrency cap under burst load and does not drop, duplicate, or corrupt any job.

**Procedure:**

```bash
npm run test:concurrency
```

This fires 50 `POST /api/jobs` requests concurrently using `Promise.all`. Each job carries a unique `idempotencyKey` and a payload `{ index: N }`.

**Expected behaviour:**

1. The API server responds `202 Accepted` to all 50 requests — no rejections, no 429s.
2. The worker picks up jobs but never exceeds **5 concurrent** in-flight jobs (`config.worker.concurrency = 5`).
3. Worker logs show batches of 5 jobs executing in parallel, with the next batch starting only after a slot frees up.
4. All 50 jobs eventually reach `succeeded`.

**Result:** ✅ Passed. The concurrency gate in `poll()` (`activeJobsCount >= config.worker.concurrency`) prevents over-subscription. The `setImmediate(poll)` call after claiming a job allows rapid back-to-back claims up to the cap, and then the worker falls back to `setTimeout(poll, pollIntervalMs)` until a slot opens.

**Why this matters:** Without the cap, a 50-job burst could spawn 50 concurrent promises, each holding a database connection and consuming memory. On a serverless database like Neon (which limits connections), this would cause connection exhaustion and cascading failures.

---

### Scenario 2: 100% Failure Run

**Objective:** Confirm that a job which always fails progresses through the retry lifecycle and lands in the dead-letter queue after exhausting `maxAttempts`.

**Procedure:**

```bash
npm run test:deadletter
```

This enqueues a single job with `{ simulateFailure: true }` in the payload. The worker's `executeWork` function checks for this flag and throws `"Simulated upstream provider failure"` every time.

**Expected behaviour:**

1. **Attempt 1:** Job moves to `processing`, fails, transitions to `pending` with `runAt` set ~2 000–2 500 ms in the future (backoff tier 1 + jitter).
2. **Attempt 2:** Job is re-claimed after the delay, fails again, transitions to `pending` with `runAt` set ~4 000–4 500 ms in the future (backoff tier 2 + jitter).
3. **Attempt 3:** Job is re-claimed, fails for the final time. Since `attempts (3) >= maxAttempts (3)`, the job transitions to `dead` with `finishedAt` set and `lastError` preserved.

**Result:** ✅ Passed. The test script polls `GET /api/jobs/:id` every 2 seconds and prints a timeline:

```
[Timeline] Status: processing | Attempts: 0/3 | Last Error: none
[Timeline] Status: pending    | Attempts: 1/3 | Last Error: Simulated upstream provider failure
[Timeline] Status: processing | Attempts: 1/3 | Last Error: Simulated upstream provider failure
[Timeline] Status: pending    | Attempts: 2/3 | Last Error: Simulated upstream provider failure
[Timeline] Status: processing | Attempts: 2/3 | Last Error: Simulated upstream provider failure
[Timeline] Status: dead       | Attempts: 3/3 | Last Error: Simulated upstream provider failure
```

**Key observations:**

- The `runAt` timestamps between retries grow exponentially, confirming the backoff formula.
- The job never enters `failed` as a persistent state visible to the poller — `failed` is an instantaneous transition back to `pending`. By the time the poller reads, the worker has already computed the backoff and reset the job. The `failed` state is logically present in the transition but the final persisted state before `dead` is always `pending` (with an updated `lastError` and incremented `attempts`).

---

### Scenario 3: Mid-Job Worker Kill & Recovery

**Objective:** Prove that if a worker is forcibly terminated (`Ctrl+C` or `kill -9`) while processing a job, the job is not lost forever.

**Procedure:**

```bash
# Terminal 1: Start the worker
npm run worker

# Terminal 2: Submit a hanging job
npm run test:hang

# Terminal 1: Wait for "Simulated hang" log, then kill the worker (Ctrl+C or kill the process)

# Terminal 1: Restart the worker
npm run worker
```

The `{ simulateHang: true }` payload causes `executeWork` to `await new Promise(() => {})` — an infinite hang. This simulates a worker that crashes or hangs after claiming work.

**Expected behaviour:**

1. The job is claimed and moves to `processing` with `startedAt` set.
2. The worker is killed. The job remains in `processing` in the database — no `finishedAt`, no status change.
3. A new worker starts. Its `stuckJobSweeper()` runs every 10 seconds. After `stuckJobTimeoutMs` (60 seconds) has elapsed since `startedAt`, the sweeper finds the orphaned job.
4. The sweeper resets the job to `pending` (if retries remain) or `dead` (if exhausted), logging `[SWEEP] Recovered stuck job <id>`.
5. The job is picked up by the normal poll loop and processed again.

**Result:** ✅ Passed. The sweeper correctly identifies and reclaims the orphaned job. The key query:

```typescript
startedAt: { lte: new Date(Date.now() - 60_000) }
```

This ensures only jobs that have been stuck for longer than the timeout threshold are reclaimed — not jobs that are legitimately still running.

---

### Scenario 4: Idempotency Key Collision

**Objective:** Verify that submitting the same `idempotencyKey` twice does not create a duplicate job.

**Procedure:**

```bash
npm run test:idempotency
```

This sends two `POST /api/jobs` requests with an identical `idempotencyKey` (`"test-idemp-key-123"`).

**Expected behaviour:**

1. **Request 1:** Returns `202 Accepted` with a new job ID.
2. **Request 2:** Prisma throws `PrismaClientKnownRequestError` with code `P2002` (unique constraint violation on `idempotencyKey`). The handler catches it, queries the existing job with `findUnique({ where: { idempotencyKey } })`, and returns `200 OK` with the **same** job ID.

**Result:** ✅ Passed.

```
Status 1: 202
Response 1 ID: clx...abc
Status 2: 200
Response 2 ID: clx...abc
✅ Idempotency confirmed: Both requests returned the same job ID.
```

**Why `P2002` catch instead of `findOrCreate`:** Prisma does not offer an atomic `findOrCreate`. A `findUnique` + `create` sequence has a TOCTOU race: two concurrent requests could both pass the `findUnique` check (finding no existing job) and both attempt to `create`, resulting in a duplicate or a crash. By attempting the `create` first and catching the unique violation, we let PostgreSQL's constraint enforcement act as the serialisation point — the approach is both race-free and requires only a single round-trip in the common (non-duplicate) case.

---

### Scenario 5: Dual-Worker Contention

**Objective:** Prove that two worker processes running simultaneously never claim the same job.

**Procedure:**

```bash
# Terminal 1
npm run worker

# Terminal 2
npm run worker

# Terminal 3: Submit 50 jobs
npm run test:concurrency
```

**Expected behaviour:**

1. Both workers poll the `Job` table concurrently.
2. The `FOR UPDATE SKIP LOCKED` clause in the claim query guarantees that if Worker A locks a row, Worker B's subquery skips it and selects the next eligible row.
3. No job ID appears in both workers' logs.
4. All 50 jobs are processed exactly once, and all reach `succeeded`.

**Result:** ✅ Passed. Cross-referencing the job IDs in both worker logs confirms zero overlap. The `SKIP LOCKED` behaviour is the critical enabler — without it, both workers would block on the same row, effectively serialising all work through a single lock.

**Trade-off observed:** With 2 workers × 5 concurrency each = 10 total in-flight slots, the 50 jobs complete roughly twice as fast as a single worker. However, each worker maintains its own `pg.Pool`, so total database connections double. For Neon's serverless connection limit, this means operators must balance worker count against connection budget.

---

## Reviewer Defence Questions

### 1. Two workers are running. Walk me through exactly how you guarantee they never process the same job.

Both workers execute the same atomic SQL claim query (`src/worker.ts`, lines 91–102):

```sql
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

Here is the step-by-step guarantee:

1. **Worker A's subquery** scans the `Job` table (using the `@@index([status, runAt])` composite index) for the first `pending` row where `runAt <= NOW()`. It acquires a **row-level `FOR UPDATE` lock** on that row.

2. **Worker B's subquery** runs concurrently. It hits the same table and the same first row — but that row is already locked by Worker A. Because of `SKIP LOCKED`, Worker B does **not** wait. It silently skips the locked row and selects the **next** eligible row.

3. **Worker A's outer `UPDATE`** promotes the advisory lock into a write: it sets `status = 'processing'` and `startedAt = NOW()`. After `RETURNING *`, Worker A has the full job object and the lock is released as the transaction commits.

4. **Worker B** has already moved on to a different row — it never saw Worker A's job.

**Critical nuance:** The `SKIP LOCKED` is what makes this non-blocking. Without it (`FOR UPDATE` alone), Worker B would **block** until Worker A's transaction commits, then discover the row is no longer `pending`, and restart its scan — functional but much slower under contention.

The entire SELECT + UPDATE is a **single SQL statement** executed in an implicit transaction, so there is no window for a race condition between "finding" and "claiming" the job. This is fundamentally impossible to achieve with Prisma's standard `findFirst` + `update` two-step API.

---

### 2. Your worker crashed after doing the work but before marking the job done. What happens when it restarts?

This is the "work completed, status update lost" scenario — the most dangerous failure mode for at-least-once systems.

**Timeline:**

1. Worker claims Job X → status becomes `processing`, `startedAt` set.
2. Worker calls `executeWork(job)` → the actual work (e.g., sending an email) **succeeds**.
3. Worker crashes (OOM, `kill -9`, power loss) **before** the `prisma.job.update({ status: "succeeded" })` on line 37–43 of `worker.ts` executes.
4. Job X is now stuck in `processing` in the database with `startedAt` set to the original claim time.

**What the system does:**

5. A new worker starts (or the surviving second worker continues). Its `stuckJobSweeper()` runs every 10 seconds.
6. After 60 seconds have elapsed since Job X's `startedAt`, the sweeper finds it:
   ```typescript
   const timeoutThreshold = new Date(Date.now() - config.worker.stuckJobTimeoutMs);
   // finds jobs WHERE status = 'processing' AND startedAt <= timeoutThreshold
   ```
7. If `attempts < maxAttempts`, the sweeper resets Job X to `pending` with `runAt = NOW()`. It **will be processed again**.
8. If `attempts >= maxAttempts`, the sweeper moves it to `dead`.

**Implication — at-least-once, not exactly-once:** The work was already done (step 2), but the system doesn't know that. It will re-execute the job. This means job handlers must be **idempotent** — performing the same work twice must produce the same result without side effects (e.g., use database upserts instead of inserts, check if an email was already sent before sending again).

**Why not exactly-once?** True exactly-once delivery requires the work and the status update to be in the **same** transaction (e.g., writing to the same database). Since our jobs call external services (APIs, email providers), we cannot wrap the external call in a PostgreSQL transaction. At-least-once with idempotent handlers is the standard industry pattern (used by SQS, Celery, Sidekiq, etc.).

---

### 3. Why jitter? Show me the line.

**The line** — `src/worker.ts`, line 60:

```typescript
const delayMs =
  config.retry.baseDelayMs * Math.pow(2, attempts)
  + Math.floor(Math.random() * config.retry.jitterMaxMs);
```

**Why jitter matters:**

Without jitter, if a downstream service (e.g., a payment gateway) goes down and causes 200 jobs to fail at time T₀, all 200 jobs would schedule their first retry at exactly T₀ + 2 000 ms. When the downstream service recovers, it gets hit with 200 simultaneous requests — potentially re-triggering the outage. This is the **thundering herd** problem.

The jitter term `Math.floor(Math.random() * config.retry.jitterMaxMs)` adds a **random uniform offset** between 0 and 500 ms on top of the deterministic exponential base. This spreads 200 retries across a 500 ms window instead of a single instant:

```
Without jitter:  |████████████████████| ← 200 requests at T₀+2000ms
With jitter:     |█·█··█·█···██··█·█·| ← 200 requests spread over T₀+2000ms to T₀+2500ms
```

**Config values** (from `src/config.ts`, lines 24–29):

```typescript
retry: {
  baseDelayMs: 1_000,    // doubles each attempt: 2s, 4s, 8s
  maxAttempts: 3,         // 3 strikes → dead
  jitterMaxMs: 500,       // random 0-500ms added to each delay
}
```

**Design choice — uniform vs. full jitter:** We use "decorrelated" uniform jitter (add random offset to exponential base) rather than "full jitter" (random between 0 and exponential cap). Full jitter can produce very short delays that defeat the purpose of backoff. Our approach guarantees that the minimum delay is always the exponential base, preserving backoff guarantees while still spreading load.

---

### 4. A job has been in `processing` for an hour. What does your system do about it and when?

The **stuck-job sweeper** (`src/worker.ts`, function `stuckJobSweeper`, lines 122–171) handles this.

**Detection:**

The sweeper runs on a 10-second interval (`setTimeout(stuckJobSweeper, 10000)` on line 170). Each cycle, it queries:

```typescript
const timeoutThreshold = new Date(Date.now() - config.worker.stuckJobTimeoutMs);
// config.worker.stuckJobTimeoutMs = 60_000 (60 seconds)

const stuckJobs = await prisma.job.findMany({
  where: {
    status: "processing",
    startedAt: { lte: timeoutThreshold },
  },
});
```

A job that has been `processing` for **1 hour** (3 600 000 ms) far exceeds the 60 000 ms threshold. It will be detected on the **very next sweeper cycle** — within 10 seconds.

**Recovery action:**

For each stuck job, the sweeper increments `attempts` and checks:

- **`attempts < maxAttempts`:** Reset to `pending` with `runAt = NOW()`, `startedAt = null`, and `lastError = "Job timed out in processing state (recovered by sweep)"`. The job re-enters the queue immediately.

- **`attempts >= maxAttempts`:** Move to `dead` with `finishedAt = NOW()` and the timeout error message. The job is quarantined for operator review.

**Timeline for a job stuck for 1 hour:**

| Time | Event |
| --- | --- |
| T₀ | Job claimed, `startedAt = T₀`, status = `processing` |
| T₀ + 60s | Job exceeds `stuckJobTimeoutMs` threshold |
| T₀ + ~60–70s | Next sweeper cycle detects the job |
| T₀ + ~60–70s | Job reset to `pending` (or `dead` if retries exhausted) |

**Why 60 seconds and not shorter?** The longest legitimate job execution in our system is the simulated work delay (1.5–2 seconds). A 60-second timeout provides a 30× safety margin. Setting it too low (e.g., 5 seconds) would cause false positives — reclaiming jobs that are still legitimately running. Setting it too high (e.g., 30 minutes) would leave dead jobs invisible for too long. The value is configurable in `src/config.ts`.

---

## Operational Guide: Dead-Letter Diagnosis & Manual Retries

### Listing Dead-Letter Jobs

Query the dead-letter queue via the API:

```bash
curl http://localhost:3000/api/jobs/dead | jq
```

Response:

```json
[
  {
    "id": "clx1abc...",
    "type": "email.send",
    "status": "dead",
    "attempts": 3,
    "maxAttempts": 3,
    "lastError": "Simulated upstream provider failure",
    "payload": { "to": "user@example.com" },
    "startedAt": "2026-09-28T...",
    "finishedAt": "2026-09-28T...",
    "createdAt": "2026-09-28T...",
    "updatedAt": "2026-09-28T..."
  }
]
```

### Diagnosing a Dead Job

1. **Read `lastError`** — this contains the error message from the final failed attempt. Common causes:
   - `"Simulated upstream provider failure"` → downstream service was down
   - `"Job timed out in processing state (recovered by sweep)"` → worker crashed mid-execution
   - `"Max attempts exceeded"` → generic exhaustion (check earlier logs for root cause)

2. **Check `attempts` vs `maxAttempts`** — confirms the job genuinely exhausted all retries.

3. **Inspect `payload`** — determine whether the job data itself is malformed (a "poison pill" that will always fail).

4. **Check `type`** — identify which job handler is responsible and review its error handling.

### Triggering a Manual Retry

Once the root cause is resolved (e.g., the downstream service is back up, a bug is fixed), retry the job:

```bash
curl -X POST http://localhost:3000/api/jobs/<JOB_ID>/retry
```

This resets the job:

| Field | New Value |
| --- | --- |
| `status` | `pending` |
| `attempts` | `0` |
| `lastError` | `null` |
| `runAt` | `NOW()` |
| `startedAt` | `null` |
| `finishedAt` | `null` |

The job immediately becomes eligible for the next worker poll cycle.

**Safety guard:** Only jobs with `status = "dead"` can be retried. Attempting to retry a `pending`, `processing`, or `succeeded` job returns `409 Conflict`:

```json
{
  "error": "Cannot retry a job with status \"processing\". Only dead jobs can be retried."
}
```

### Bulk Retry Pattern

The API does not provide a bulk retry endpoint. To retry all dead jobs, script it:

```bash
# Get all dead job IDs and retry each one
curl -s http://localhost:3000/api/jobs/dead | jq -r '.[].id' | while read id; do
  echo "Retrying $id..."
  curl -s -X POST "http://localhost:3000/api/jobs/$id/retry" | jq '.status'
done
```

### Monitoring Recommendations

- **Alert on dead-letter queue growth:** Poll `GET /api/jobs/dead` periodically. If the count exceeds a threshold, trigger an alert.
- **Track `lastError` patterns:** If multiple dead jobs share the same `lastError`, the root cause is likely a single downstream dependency.
- **Watch sweeper logs:** `[SWEEP] Recovered stuck job` messages indicate worker instability — investigate memory usage, connection limits, or deployment issues.
