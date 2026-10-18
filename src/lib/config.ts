/**
 * Central runtime configuration for Ryomen.
 *
 * Everything is driven by environment variables with sane defaults so the bot
 * runs out of the box against the public CoinGecko API.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

export const config = {
  coingecko: {
    baseUrl: str(process.env.COINGECKO_BASE_URL, "https://api.coingecko.com/api/v3"),
    apiKey: process.env.COINGECKO_API_KEY ?? null,
    /**
     * The free tier hard-rate-limits (measured: 3 rapid requests succeed, the
     * 4th returns HTTP 429 with no Retry-After). Rather than probing for the
     * limit at runtime, we spend a deliberately small fixed budget.
     */
    requestsPerMinute: num(process.env.COINGECKO_REQUESTS_PER_MINUTE, 5),
    /** Requests allowed to go back-to-back before the bucket must refill. */
    burst: num(process.env.COINGECKO_BURST, 2),
  },
  db: {
    path: str(process.env.RYOMEN_DB_PATH, "data/ryomen.db"),
  },
  cache: {
    ttlSeconds: num(process.env.RYOMEN_CACHE_TTL_SECONDS, 300),
    /**
     * How long stale data may still be served while a refresh runs in the
     * background. This is what keeps the dashboard instant: a cache miss never
     * blocks on the network as long as *any* usable copy exists.
     */
    staleTtlSeconds: num(process.env.RYOMEN_STALE_TTL_SECONDS, 3600),
  },
  paper: {
    startingCash: num(process.env.RYOMEN_STARTING_CASH, 10_000),
    /** Trading fee in basis points (10 bps = 0.10%). */
    feeBps: num(process.env.RYOMEN_FEE_BPS, 10),
    /** Simulated slippage in basis points applied against the fill. */
    slippageBps: num(process.env.RYOMEN_SLIPPAGE_BPS, 5),
  },
} as const;
