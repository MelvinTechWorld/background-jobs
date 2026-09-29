// Quick smoke test for the API server
import http from "node:http";

function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "localhost",
        port: 3000,
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => (raw += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log("=== POST /api/jobs (create) ===");
  const r1 = await request("POST", "/api/jobs", {
    type: "email.send",
    payload: { to: "test@example.com" },
    idempotencyKey: "smoke-test-1",
  });
  console.log(`Status: ${r1.status}`);
  console.log(JSON.stringify(r1.data, null, 2));

  console.log("\n=== POST /api/jobs (idempotent duplicate) ===");
  const r2 = await request("POST", "/api/jobs", {
    type: "email.send",
    payload: { to: "test@example.com" },
    idempotencyKey: "smoke-test-1",
  });
  console.log(`Status: ${r2.status}`);
  console.log(JSON.stringify(r2.data, null, 2));

  const jobId = (r1.data as Record<string, unknown>).id as string;

  console.log(`\n=== GET /api/jobs/${jobId} ===`);
  const r3 = await request("GET", `/api/jobs/${jobId}`);
  console.log(`Status: ${r3.status}`);
  console.log(JSON.stringify(r3.data, null, 2));

  console.log("\n=== GET /api/jobs/dead ===");
  const r4 = await request("GET", "/api/jobs/dead");
  console.log(`Status: ${r4.status}`);
  console.log(JSON.stringify(r4.data, null, 2));

  console.log("\n=== POST /api/jobs (bad payload) ===");
  const r5 = await request("POST", "/api/jobs", { type: "" });
  console.log(`Status: ${r5.status}`);
  console.log(JSON.stringify(r5.data, null, 2));

  console.log("\n✅ Smoke test complete!");
}

main().catch(console.error);
