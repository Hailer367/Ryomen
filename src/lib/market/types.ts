/** Shared market-data primitives. */

/** A single OHLC bar. `time` is a Unix timestamp in **seconds** (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Data granularity label, e.g. "30m" | "4h" | "1d". */
export type Granularity = "5m" | "30m" | "1h" | "4h" | "1d";

/** A candle series plus the metadata needed to reason about it. */
export interface CandleSeries {
  coinId: string;
  granularity: Granularity;
  /** Requested lookback window in days. */
  days: number;
  candles: Candle[];
  /** Epoch ms when the series was produced (from cache or network). */
  fetchedAt: number;
  source: "coingecko-ohlc" | "coingecko-market-chart" | "cache";
}

/** Live ticker snapshot from `/simple/price`. */
export interface Ticker {
  coinId: string;
  priceUsd: number;
  change24hPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  updatedAt: number;
}
