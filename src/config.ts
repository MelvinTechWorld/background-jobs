/**
 * Centralized configuration — no hardcoded magic numbers anywhere else.
 * Every tunable lives here so tests and operators can override in one place.
 */

export const config = {
  /** HTTP server settings */
  server: {
    port: parseInt(process.env["PORT"] ?? "3000", 10),
  },

  /** Worker polling & concurrency */
  worker: {
    /** Max concurrent jobs a single worker process will run */
    concurrency: 5,
    /** How often (ms) the worker polls for pending jobs */
    pollIntervalMs: 1_000,
    /** Jobs stuck in "processing" longer than this (ms) are reclaimed */
    stuckJobTimeoutMs: 60_000,
  },

  /** Retry / back-off settings */
  retry: {
    /** Base delay (ms) before the first retry — doubles each attempt */
    baseDelayMs: 1_000,
    /** Total attempts before a job lands in the dead-letter queue */
    maxAttempts: 3,
    /** Random jitter cap (ms) added on top of exponential delay */
    jitterMaxMs: 500,
  },
} as const;
