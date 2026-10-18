import type { Candle, Granularity } from "@/lib/market/types";

/** Bucket size in seconds for each supported granularity. */
export const GRANULARITY_SECONDS: Record<Granularity, number> = {
  "5m": 300,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

/**
 * Resample a candle series into a coarser bucket.
 *
 * This is the core of Ryomen's efficiency story: CoinGecko's free tier serves
 * `/market_chart` as hourly for up to 90 days, which is a far richer series than
 * `/ohlc` provides (4-hourly for the same window). One cached hourly series can
 * therefore serve 4-hourly and daily chart views too, so a coin costs one API
 * call instead of one per chart range.
 *
 * Buckets are aligned to UTC epoch boundaries.
 */
export function resample(candles: readonly Candle[], target: Granularity): Candle[] {
  const size = GRANULARITY_SECONDS[target];
  if (candles.length === 0) return [];

  const native = detectGranularity(candles);
  if (native === target || GRANULARITY_SECONDS[native] >= size) return [...candles];

  const out: Candle[] = [];
  let bucket = -1;
  let current: Candle | null = null;

  for (const c of candles) {
    const b = Math.floor(c.time / size) * size;
    if (b !== bucket) {
      if (current) out.push(current);
      bucket = b;
      current = { time: b, open: c.open, high: c.high, low: c.low, close: c.close };
    } else if (current) {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Infer the native granularity of a series from its median bar spacing. */
export function detectGranularity(candles: readonly Candle[]): Granularity {
  if (candles.length < 3) return "1d";
  const gaps: number[] = [];
  const step = Math.max(1, Math.floor(candles.length / 50));
  for (let i = step; i < candles.length; i += step) {
    gaps.push(candles[i].time - candles[i - 1].time);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  let best: Granularity = "1d";
  let bestDelta = Infinity;
  for (const key of Object.keys(GRANULARITY_SECONDS) as Granularity[]) {
    const delta = Math.abs(GRANULARITY_SECONDS[key] - median);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = key;
    }
  }
  return best;
}

/** Drop to the requested granularity, never upsampling (silently returns all). */
export function toGranularity(candles: readonly Candle[], target: Granularity): Candle[] {
  return resample(candles, target);
}
