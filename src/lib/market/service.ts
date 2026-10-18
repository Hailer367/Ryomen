import { COIN_IDS } from "@/lib/coins";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { fetchMarketChart, fetchSimplePrices, getCoinGeckoStats, noteCacheHit } from "@/lib/coingecko/client";
import type { Candle, CandleSeries, Granularity, Ticker } from "@/lib/market/types";
import { GRANULARITY_SECONDS, resample } from "@/lib/market/series";

export type CandleSource = "ohlc" | "market-chart";

export interface GetCandlesOptions {
  days?: number | "max";
  source?: CandleSource;
  /** Override the cache TTL (seconds). */
  maxAgeSeconds?: number;
  /** Skip the cache and force a refetch. */
  force?: boolean;
}

interface CacheMeta {
  coin_id: string;
  granularity: string;
  source: string;
  fetched_at: number;
  covers_from: number;
  covers_to: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * How far behind `now` the cached tail may sit and still count as covering the
 * window. Daily series legitimately end at the last completed bar.
 */
function slackFor(granularity: Granularity): number {
  return GRANULARITY_SECONDS[granularity] * 2 + 3600;
}

function readMeta(coinId: string, granularity: Granularity): CacheMeta | null {
  const row = getDb()
    .prepare(`SELECT * FROM candle_cache_meta WHERE coin_id = ? AND granularity = ?`)
    .get(coinId, granularity) as CacheMeta | undefined;
  return row ?? null;
}

function readCandles(coinId: string, granularity: Granularity): Candle[] {
  return getDb()
    .prepare(`SELECT time, open, high, low, close FROM candles WHERE coin_id = ? AND granularity = ? ORDER BY time ASC`)
    .all(coinId, granularity) as Candle[];
}

function writeSeries(coinId: string, granularity: Granularity, source: string, candles: Candle[]): void {
  if (candles.length === 0) return;
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO candles (coin_id, granularity, time, open, high, low, close)
     VALUES (@coin_id, @granularity, @time, @open, @high, @low, @close)
     ON CONFLICT (coin_id, granularity, time) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close`,
  );
  const stmt = db.transaction((rows: Candle[]) => {
    for (const c of rows) insert.run({ coin_id: coinId, granularity, ...c });
  });
  stmt(candles);

  const coversFrom = candles[0].time;
  const coversTo = candles[candles.length - 1].time;
  db.prepare(
    `INSERT INTO candle_cache_meta (coin_id, granularity, source, fetched_at, covers_from, covers_to)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (coin_id, granularity) DO UPDATE SET
       source = excluded.source, fetched_at = excluded.fetched_at,
       covers_from = excluded.covers_from, covers_to = excluded.covers_to`,
  ).run(coinId, granularity, source, nowSeconds(), coversFrom, coversTo);
}

/** Which cached (native) series and which output granularity this request needs. */
function planFor(days: number | "max", source: CandleSource) {
  const cutoff = days === "max" ? 0 : nowSeconds() - Math.ceil(days * 86_400);
  if (source === "market-chart") {
    // Backtests want the finest resolution available for the window.
    const native: Granularity = days === "max" || days > 90 ? "1d" : days <= 1 ? "5m" : "1h";
    return { native, target: native, cutoff };
  }
  // Charts: derive every range from one cached series, choosing a bucket that
  // keeps the bar count dense and monotonic across the range switcher. Only the
  // 1Y view falls back to daily, because CoinGecko stops serving hourly past
  // 90 days — that is the finest resolution available for a year of history.
  const target: Granularity = days === "max" || days > 90 ? "1d" : days <= 7 ? "1h" : "4h";
  const native: Granularity = target === "1d" ? "1d" : "1h";
  return { native, target, cutoff };
}

async function fetchNative(coinId: string, native: Granularity): Promise<Candle[]> {
  // `/market_chart` is the richest endpoint the free tier offers: 5-minutely
  // for 1 day, hourly up to 90 days, daily beyond. CoinGecko hard-caps the
  // window at 365 days — larger values are rejected outright — so 365 daily
  // bars is all the long-range history that exists.
  const days: number | "max" = native === "1d" ? 365 : native === "5m" ? 1 : 90;
  const { candles } = await fetchMarketChart(coinId, days);
  return candles;
}

/** Refresh a series in the background; failures are swallowed by design. */
function scheduleRefresh(coinId: string, native: Granularity): void {
  void (async () => {
    try {
      const fresh = await fetchNative(coinId, native);
      if (fresh.length > 0) writeSeries(coinId, native, "coingecko-market-chart", fresh);
    } catch {
      // Keep serving the stale copy; the next visit tries again.
    }
  })();
}

function isFresh(meta: CacheMeta, ttl: number): boolean {
  return nowSeconds() - meta.fetched_at < ttl;
}

function coversWindow(meta: CacheMeta, cutoff: number, native: Granularity): boolean {
  const now = nowSeconds();
  const slack = slackFor(native);
  if (cutoff === 0) return true; // "max" — any history counts
  return meta.covers_from <= cutoff + slack && meta.covers_to >= now - slack;
}

/**
 * Fetch a coin's candle history, preferring the SQLite cache.
 *
 * Resolution strategy:
 *  1. work out which cached series can answer the request (`planFor`),
 *  2. if a cached copy covers the window, serve it immediately — even if stale,
 *     refreshing in the background (stale-while-revalidate),
 *  3. otherwise block on a single network call, then resample.
 *
 * The practical effect is that a fully warm Ryomen issues **zero** CoinGecko
 * requests during normal browsing.
 */
export async function getCandles(coinId: string, options: GetCandlesOptions = {}): Promise<CandleSeries> {
  const days = options.days ?? 30;
  const source: CandleSource = options.source ?? "ohlc";
  const ttl = options.maxAgeSeconds ?? config.cache.ttlSeconds;
  const { native, target, cutoff } = planFor(days, source);

  const build = (candles: Candle[], servedFrom: CandleSeries["source"]): CandleSeries => {
    // Resample first so bucket boundaries stay aligned to real bar times, then
    // window. `edge` keeps the boundary bucket rather than dropping a partial bar.
    const resampled = target === native ? candles : resample(candles, target);
    const edge = cutoff ? cutoff - GRANULARITY_SECONDS[target] : 0;
    return {
      coinId,
      granularity: target,
      days: typeof days === "number" ? days : 0,
      candles: edge ? resampled.filter((c) => c.time >= edge) : resampled,
      fetchedAt: Date.now(),
      source: servedFrom,
    };
  };

  const meta = options.force ? null : readMeta(coinId, native);

  if (meta && coversWindow(meta, cutoff, native)) {
    const cached = readCandles(coinId, native);
    if (cached.length > 0) {
      noteCacheHit();

      if (options.force) {
        scheduleRefresh(coinId, native);
      } else if (isFresh(meta, ttl)) {
        // Nothing to do.
      } else if (nowSeconds() - meta.fetched_at < config.cache.staleTtlSeconds) {
        scheduleRefresh(coinId, native);
      } else {
        scheduleRefresh(coinId, native);
      }
      return build(cached, "cache");
    }
  }

  // Cache miss (or unusable coverage): this is the only path that blocks.
  try {
    const fresh = await fetchNative(coinId, native);
    if (fresh.length === 0) throw new Error(`No candle data returned for ${coinId}`);
    writeSeries(coinId, native, "coingecko-market-chart", fresh);
    return build(fresh, "coingecko-market-chart");
  } catch (err) {
    // Last resort: serve whatever we have, at whatever resolution we have.
    const fallbackMeta = readMeta(coinId, native);
    if (fallbackMeta) {
      const cached = readCandles(coinId, native);
      if (cached.length > 0) {
        noteCacheHit();
        return build(cached, "cache");
      }
    }
    throw err;
  }
}

/* ── Tickers ────────────────────────────────────────────────────────────── */

function rowToTicker(row: {
  coin_id: string;
  price_usd: number;
  change_24h_pct: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  updated_at: number;
}): Ticker {
  return {
    coinId: row.coin_id,
    priceUsd: row.price_usd,
    change24hPct: row.change_24h_pct,
    marketCapUsd: row.market_cap_usd,
    volume24hUsd: row.volume_24h_usd,
    updatedAt: row.updated_at * 1000,
  };
}

/** Read the last persisted ticker snapshots without touching the network. */
export function getCachedTickers(): Ticker[] {
  const rows = getDb().prepare(`SELECT * FROM tickers`).all() as Parameters<typeof rowToTicker>[0][];
  return rows.map(rowToTicker);
}

function storeTickers(prices: Record<string, { priceUsd: number; change24hPct: number | null; marketCapUsd: number | null; volume24hUsd: number | null }>): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO tickers (coin_id, price_usd, change_24h_pct, market_cap_usd, volume_24h_usd, updated_at)
     VALUES (@coin_id, @price_usd, @change_24h_pct, @market_cap_usd, @volume_24h_usd, @updated_at)
     ON CONFLICT (coin_id) DO UPDATE SET
       price_usd = excluded.price_usd, change_24h_pct = excluded.change_24h_pct,
       market_cap_usd = excluded.market_cap_usd, volume_24h_usd = excluded.volume_24h_usd,
       updated_at = excluded.updated_at`,
  );
  const ts = nowSeconds();
  const tx = db.transaction(() => {
    for (const id of COIN_IDS) {
      const e = prices[id];
      if (!e) continue;
      upsert.run({
        coin_id: id,
        price_usd: e.priceUsd,
        change_24h_pct: e.change24hPct,
        market_cap_usd: e.marketCapUsd,
        volume_24h_usd: e.volume24hUsd,
        updated_at: ts,
      });
    }
  });
  tx();
}

function refreshTickers(): Promise<void> {
  return fetchSimplePrices(COIN_IDS).then((prices) => {
    if (Object.keys(prices).length > 0) storeTickers(prices);
  });
}

/**
 * Live tickers for all eight coins — a single `/simple/price` call covers them.
 *
 * Stale-while-revalidate: once anything is cached, callers get an immediate
 * answer and the refresh happens in the background.
 */
export async function getTickers(options: { force?: boolean } = {}): Promise<Ticker[]> {
  const cached = getCachedTickers();
  const ttl = config.cache.ttlSeconds;

  if (cached.length > 0) {
    if (options.force) {
      void refreshTickers().catch(() => undefined);
    } else {
      const oldest = Math.min(...cached.map((t) => t.updatedAt));
      if (nowSeconds() - Math.floor(oldest / 1000) >= ttl) {
        void refreshTickers().catch(() => undefined);
      }
    }
    return cached;
  }

  try {
    await refreshTickers();
  } catch {
    // fall through to whatever landed (possibly nothing)
  }
  return getCachedTickers();
}

export { getCoinGeckoStats };
