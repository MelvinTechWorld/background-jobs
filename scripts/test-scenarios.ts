import crypto from "node:crypto";

const API_BASE = "http://localhost:3000/api/jobs";

async function enqueueJob(payload: unknown, idempotencyKey?: string) {
  const key = idempotencyKey || crypto.randomUUID();
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "test.job",
      payload,
      idempotencyKey: key,
    }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

async function getJob(id: string) {
  const res = await fetch(`${API_BASE}/${id}`);
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

async function testConcurrency() {
  console.log("=== Testing Concurrency (50 Jobs) ===");
  const promises = [];
  for (let i = 1; i <= 50; i++) {
    promises.push(enqueueJob({ index: i, text: `Concurrency test job ${i}` }));
  }
  console.log("Submitting 50 jobs concurrently...");
  await Promise.all(promises);
  console.log("✅ Successfully submitted 50 jobs!");
}

async function testIdempotency() {
  console.log("=== Testing Idempotency ===");
  const idempKey = "test-idemp-key-123";
  
  console.log("Sending first request...");
  const res1 = await enqueueJob({ text: "First request" }, idempKey);
  console.log(`Status 1: ${res1.status}`);
  console.log(`Response 1 ID: ${res1.data.id}`);

  console.log("Sending second request...");
  const res2 = await enqueueJob({ text: "Second request" }, idempKey);
  console.log(`Status 2: ${res2.status}`);
  console.log(`Response 2 ID: ${res2.data.id}`);
  
  if (res1.data.id === res2.data.id) {
    console.log("✅ Idempotency confirmed: Both requests returned the same job ID.");
  } else {
    console.log("❌ Idempotency failed!");
  }
}

async function testFailureAndDeadLetter() {
  console.log("=== Testing Failure & Dead Letter ===");
  const { data: job, status } = await enqueueJob({ simulateFailure: true });
  if (status !== 202 && status !== 200) {
    throw new Error(`Failed to enqueue job: ${JSON.stringify(job)}`);
  }
  
  const jobId = job.id as string;
  console.log(`Enqueued job ${jobId} with simulated failure.`);
  console.log("Polling status every 2 seconds...");

  let isDead = false;
  let lastAttempts = -1;
  let lastStatus = "";

  while (!isDead) {
    const { data: jobData } = await getJob(jobId);
    
    if (jobData.attempts !== lastAttempts || jobData.status !== lastStatus) {
      console.log(`[Timeline] Status: ${jobData.status} | Attempts: ${jobData.attempts}/${jobData.maxAttempts} | Last Error: ${jobData.lastError || "none"}`);
      lastAttempts = jobData.attempts as number;
      lastStatus = jobData.status as string;
    }
    
    if (jobData.status === "dead") {
      console.log(`✅ Job ${jobId} has reached the dead letter queue!`);
      isDead = true;
    } else {
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

async function testStuckJobTrigger() {
  console.log("=== Testing Stuck Job Trigger ===");
  const { data: job } = await enqueueJob({ simulateHang: true });
  console.log(`✅ Enqueued stuck job ID: ${job.id}`);
  console.log(`Run 'npm run server' and 'npm run worker' (if not already running).`);
  console.log(`Observe the worker logs. It should pick up the job and hang.`);
  console.log(`Wait ~60 seconds (the stuckJobTimeoutMs threshold). The sweeper will recover it and reset it to pending.`);
}

const arg = process.argv[2];

switch (arg) {
  case "concurrency":
    testConcurrency().catch(console.error);
    break;
  case "idempotency":
    testIdempotency().catch(console.error);
    break;
  case "deadletter":
    testFailureAndDeadLetter().catch(console.error);
    break;
  case "hang":
    testStuckJobTrigger().catch(console.error);
    break;
  default:
    console.log("Usage: tsx scripts/test-scenarios.ts [concurrency|idempotency|deadletter|hang]");
}
