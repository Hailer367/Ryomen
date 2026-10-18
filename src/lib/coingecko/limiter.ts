/**
 * Rate limiting for the CoinGecko free tier.
 *
 * Measured behaviour (Oct 2026, public API, no key): three rapid requests
 * succeed and the fourth returns HTTP 429, with no documented Retry-After.
 * So the only viable strategy is to make *fewer* requests, not faster ones —
 * this module exists to spend a small, predictable budget rather than to
 * discover the hard limit at runtime.
 */

/**
 * A token bucket: `burst` requests may go immediately, then it refills at
 * `requestsPerMinute`. Requests are still served FIFO through a serial chain,
 * so a slow call can never reorder or starve others.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private lastRefill: number;
  private chain: Promise<unknown> = Promise.resolve();
  private cooldownUntil = 0;
  private consecutive429 = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private get refillPerMs(): number {
    return this.requestsPerMinute / 60_000;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }

  /**
   * Global circuit breaker. When a 429 is seen, *every* caller backs off —
   * not just the request that tripped it. Without this, N queued requests each
   * discover the limit independently and burn N round trips discovering it.
   */
  penalise(retryAfterMs: number): void {
    this.consecutive429 += 1;
    // Exponential backoff, capped, so a persistent block doesn't retry-hop.
    const backoff = Math.max(retryAfterMs, Math.min(120_000, 5_000 * 2 ** (this.consecutive429 - 1)));
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + backoff);
  }

  succeed(): void {
    this.consecutive429 = 0;
  }

  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  /** Run `task` once a token is available, preserving call order. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        const cooldown = this.cooldownUntil - now;
        if (cooldown > 0) {
          await sleep(cooldown);
          continue;
        }
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          break;
        }
        await sleep(Math.ceil((1 - this.tokens) / this.refillPerMs) + 5);
      }
      return task();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
