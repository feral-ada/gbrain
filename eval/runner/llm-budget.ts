/**
 * Shared LLM rate-limit bucket (Day 10 of BrainBench v1 Complete plan).
 *
 * Wraps Anthropic API calls across the agent adapter (Sonnet) and the
 * judge (Haiku) with a single token-bucket rate limiter. A full N=10
 * scorecard run makes ~900 LLM calls (150 Cat 8/9 probes × N=10 + 100
 * Cat 5 claims × N=10); without coordination the concurrent adapters
 * trigger 429s on Anthropic's per-minute limits.
 *
 * Design:
 *   - `acquireSlot()` resolves when a slot is free (blocks otherwise).
 *   - `releaseSlot()` frees the slot. Use try/finally around the LLM call.
 *   - `withLlmSlot(fn)` is the convenience wrapper: acquires, runs `fn()`,
 *     releases on both success and failure.
 *
 * The default capacity (4 concurrent LLM calls) is tuned for Anthropic's
 * per-minute + per-day tier limits. Override via env or config when
 * running against a tier with looser caps.
 *
 * Not a general-purpose scheduler — just a semaphore. For exponential
 * backoff on 429s, individual callers still use their own retry logic
 * (see agent adapter's `isRateLimitError` + backoff).
 */

export interface LlmBudgetConfig {
  /** Max concurrent in-flight LLM calls. Default 4. */
  maxConcurrent?: number;
}

export class LlmBudget {
  private maxConcurrent: number;
  private inFlight = 0;
  private waiting: Array<() => void> = [];

  constructor(config: LlmBudgetConfig = {}) {
    this.maxConcurrent = Math.max(1, config.maxConcurrent ?? 4);
  }

  get capacity(): number {
    return this.maxConcurrent;
  }

  get activeCount(): number {
    return this.inFlight;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Acquire one budget slot. Resolves immediately if free; otherwise
   * queues until another caller releases a slot.
   */
  acquireSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiting.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  /**
   * Release one budget slot. Wakes the oldest waiter if any.
   */
  releaseSlot(): void {
    if (this.inFlight === 0) return; // double-release guard
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }

  /**
   * Run `fn` under an acquired slot. Releases on success + failure.
   */
  async withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}

// ─── Process-global default budget ────────────────────────────────────

let defaultBudget: LlmBudget | null = null;

export function getDefaultLlmBudget(): LlmBudget {
  if (!defaultBudget) {
    const envCap = process.env.BRAINBENCH_LLM_CONCURRENCY;
    const cap = envCap ? parseInt(envCap, 10) : 4;
    defaultBudget = new LlmBudget({ maxConcurrent: Number.isFinite(cap) ? cap : 4 });
  }
  return defaultBudget;
}

/** For test cleanup — resets the process-global budget. */
export function resetDefaultLlmBudget(): void {
  defaultBudget = null;
}
