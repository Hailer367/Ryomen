import { config } from "@/lib/config";
import { sleep, TokenBucketLimiter } from "@/lib/coingecko/limiter";

/**
 * Shared, hot-reload-safe state for the CoinGecko client.
 *
 * Three things live here:
 *  - the token bucket (one budget for the whole process),
 *  - ETags per URL (lets us make free conditional requests),
 *  - in-flight promises (so N concurrent callers share one network call).
 */
const g = globalThis as unknown as {
  __ryomenCgLimiter?: TokenBucketLimiter;
  __ryomenCgEtag?: Map<string, string>;
  __ryomenCgInflight?: Map<string, Promise<unknown>>;
  __ryomenCgStats?: CgStats;
};

export interface CgStats {
  /** Total outbound HTTP attempts actually made. */
  requests: number;
  /** Calls served entirely from the local cache — never left the process. */
  cacheHits: number;
  /** Duplicate concurrent calls collapsed into one network request. */
  coalesced: number;
  /** Responses that were HTTP 304 (ETag matched — near-zero upstream cost). */
  notModified: number;
  /** Times we were throttled with HTTP 429. */
  rateLimited: number;
  /** Bytes received over the wire. */
  bytes: number;
}

function stats(): CgStats {
  if (!g.__ryomenCgStats) {
    g.__ryomenCgStats = { requests: 0, cacheHits: 0, coalesced: 0, notModified: 0, rateLimited: 0, bytes: 0 };
  }
  return g.__ryomenCgStats;
}

function limiter(): TokenBucketLimiter {
  if (!g.__ryomenCgLimiter) {
    g.__ryomenCgLimiter = new TokenBucketLimiter(config.coingecko.requestsPerMinute, config.coingecko.burst);
  }
  return g.__ryomenCgLimiter;
}

function etagStore(): Map<string, string> {
  if (!g.__ryomenCgEtag) g.__ryomenCgEtag = new Map();
  return g.__ryomenCgEtag;
}

function inflight(): Map<string, Promise<unknown>> {
  if (!g.__ryomenCgInflight) g.__ryomenCgInflight = new Map();
  return g.__ryomenCgInflight;
}

export function getCoinGeckoStats(): CgStats {
  return { ...stats(), cooldownMs: limiter().cooldownRemainingMs } as CgStats;
}

export function noteCacheHit(): void {
  stats().cacheHits += 1;
}

export class CoinGeckoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CoinGeckoError";
  }
}

const ALLOWED_DAYS = new Set([1, 7, 14, 30, 90, 180, 365]);

/** Normalise a requested window into one CoinGecko accepts. */
export function normaliseDays(days: number | "max"): number | "max" {
  if (days === "max") return "max";
  if (ALLOWED_DAYS.has(days)) return days;
  const ordered = [1, 7, 14, 30, 90, 180, 365];
  return ordered.find((d) => d >= days) ?? 365;
}

/** Infer granularity from the requested window, matching CoinGecko's OHLC rules. */
export function granularityForDays(days: number | "max"): "30m" | "4h" | "1d" {
  if (days === "max") return "1d";
  if (days === 1) return "30m";
  if (days <= 30) return "4h";
  return "1d";
}

type QueryParams = Record<string, string | number>;

function buildUrl(path: string, params: QueryParams): string {
  const url = new URL(`${config.coingecko.baseUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * One network call, budgeted and de-duplicated.
 *
 * Returns `null` when the server replies 304 Not Modified, meaning the body we
 * already hold is still current — that is the cheapest possible poll.
 */
async function fetchJson(path: string, params: QueryParams): Promise<unknown | null> {
  const url = buildUrl(path, params);
  const pending = inflight().get(url);
  if (pending) {
    stats().coalesced += 1;
    return pending as Promise<unknown | null>;
  }

  const promise = limiter()
    .run(async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.coingecko.apiKey) headers["x-cg-demo-api-key"] = config.coingecko.apiKey;
      const etag = etagStore().get(url);
      if (etag) headers["if-none-match"] = etag;

      const maxAttempts = 3;
      let attempt = 0;

      for (;;) {
        attempt += 1;
        let res: Response;
        try {
          res = await fetch(url, { headers, cache: "no-store" });
        } catch (err) {
          if (attempt >= maxAttempts) throw err;
          await sleep(400 * attempt);
          continue;
        }

        stats().requests += 1;

        // Cheap success: server confirms our copy is still valid.
        if (res.status === 304) {
          stats().notModified += 1;
          limiter().succeed();
          return null;
        }

        if (res.status === 429) {
          stats().rateLimited += 1;
          const retryAfter = Number(res.headers.get("retry-after"));
          const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000;
          limiter().penalise(ms);
          if (attempt >= maxAttempts) {
            throw new CoinGeckoError("Rate limited by CoinGecko (all retries exhausted)", 429);
          }
          continue; // the bucket's cooldown will hold us before the retry
        }

        if (res.status === 404) throw new CoinGeckoError(`Not found: ${path}`, 404);

        if (!res.ok) {
          if (attempt < maxAttempts) {
            await sleep(500 * attempt);
            continue;
          }
          throw new CoinGeckoError(`CoinGecko ${res.status} for ${path}`, res.status);
        }

        const body = await res.text();
        stats().bytes += body.length;
        const newEtag = res.headers.get("etag");
        if (newEtag) etagStore().set(url, newEtag);

        limiter().succeed();
        return JSON.parse(body) as unknown;
      }
    })
    .finally(() => {
      inflight().delete(url);
    });

  inflight().set(url, promise);
  return promise;
}

/* ── Endpoints ──────────────────────────────────────────────────────────── */

import type { Candle } from "@/lib/market/types";

/** True OHLC bars from `/coins/{id}/ohlc`. Returns ascending by time. */
export async function fetchOhlc(coinId: string, days: number | "max"): Promise<Candle[]> {
  const raw = (await fetchJson(`/coins/${coinId}/ohlc`, {
    vs_currency: "usd",
    days: normaliseDays(days),
  })) as number[][] | null;

  // 304 can only happen if we re-read a body we already have; treat as stale-empty.
  if (raw === null) return [];
  return (raw ?? [])
    .map(([t, o, h, l, c]) => ({
      time: Math.floor(t / 1000),
      open: o,
      high: h,
      low: l,
      close: c,
    }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

/**
 * Close-price series from `/coins/{id}/market_chart`. CoinGecko returns
 * 5-minutely for 1 day, hourly up to 90 days and daily beyond that. We convert
 * the points into synthetic candles (O=H=L=C within a bucket) which is lossless
 * for close-driven strategies and yields far more bars than `/ohlc` on the free
 * tier — so this is the one call per coin that we aim to keep warm.
 */
export async function fetchMarketChart(
  coinId: string,
  days: number | "max",
): Promise<{ candles: Candle[]; granularity: "5m" | "1h" | "1d" }> {
  const raw = (await fetchJson(`/coins/${coinId}/market_chart`, {
    vs_currency: "usd",
    days,
  })) as { prices: [number, number][] } | null;

  if (raw === null) return { candles: [], granularity: marketChartGranularity(days) };

  const candles: Candle[] = [];
  let prevClose: number | null = null;
  for (const [ms, price] of raw.prices ?? []) {
    if (!Number.isFinite(price) || price <= 0) continue;
    const open = prevClose ?? price;
    candles.push({
      time: Math.floor(ms / 1000),
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
    });
    prevClose = price;
  }
  candles.sort((a, b) => a.time - b.time);
  return { candles, granularity: marketChartGranularity(days) };
}

function marketChartGranularity(days: number | "max"): "5m" | "1h" | "1d" {
  if (days === "max") return "1d";
  if (days <= 1) return "5m";
  if (days <= 90) return "1h";
  return "1d";
}

export interface SimplePriceEntry {
  priceUsd: number;
  change24hPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

/** Live snapshots for up to ~50 ids in a single call — one call covers all eight. */
export async function fetchSimplePrices(
  coinIds: readonly string[],
): Promise<Record<string, SimplePriceEntry>> {
  const raw = (await fetchJson("/simple/price", {
    ids: coinIds.join(","),
    vs_currencies: "usd",
    include_24hr_change: "true",
    include_market_cap: "true",
    include_24hr_vol: "true",
  })) as Record<string, Record<string, number>> | null;

  if (raw === null) return {};

  const out: Record<string, SimplePriceEntry> = {};
  for (const id of coinIds) {
    const entry = raw[id];
    if (!entry) continue;
    out[id] = {
      priceUsd: entry.usd ?? 0,
      change24hPct: entry.usd_24h_change ?? null,
      marketCapUsd: entry.usd_market_cap ?? null,
      volume24hUsd: entry.usd_24h_vol ?? null,
    };
  }
  return out;
}
