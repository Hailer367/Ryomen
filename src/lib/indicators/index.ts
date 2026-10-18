import type { Candle } from "@/lib/market/types";

/** A numeric series aligned 1:1 with the input; `null` during warm-up. */
export type Series = (number | null)[];

/**
 * Memoise derived series per (candle array, key).
 *
 * The engine calls `evaluate()` once per bar, so an indicator recomputed from
 * scratch inside a strategy costs O(n) *per bar* — O(n²) for a run, which makes
 * parameter search impossibly slow. The same `candles` array object is reused
 * for every bar of a run, so keying a WeakMap on it collapses the work to once
 * per run.
 */
const memoStore = new WeakMap<object, Map<string, unknown>>();

export function memoized<T>(owner: object, key: string, compute: () => T): T {
  let bucket = memoStore.get(owner);
  if (!bucket) {
    bucket = new Map<string, unknown>();
    memoStore.set(owner, bucket);
  }
  if (bucket.has(key)) return bucket.get(key) as T;
  const value = compute();
  bucket.set(key, value);
  return value;
}

/** Simple moving average. */
export function sma(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Rolling population standard deviation. */
export function stdev(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 1) return out;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= period) {
      sum -= values[i - period];
      sumSq -= values[i - period] * values[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean);
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

/** Wilder-smoothed Relative Strength Index. */
export function rsi(values: readonly number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface BollingerBands {
  middle: Series;
  upper: Series;
  lower: Series;
}

export function bollinger(values: readonly number[], period = 20, mult = 2): BollingerBands {
  const middle = sma(values, period);
  const sd = stdev(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const m = middle[i];
    const s = sd[i];
    if (m === null || s === null) continue;
    upper[i] = m + mult * s;
    lower[i] = m - mult * s;
  }
  return { middle, upper, lower };
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f === null || s === null) continue;
    macdLine[i] = f - s;
  }
  // The signal line is an EMA of the (sparse) MACD line.
  const dense: number[] = [];
  const indexMap: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) {
      dense.push(macdLine[i] as number);
      indexMap.push(i);
    }
  }
  const denseSignal = ema(dense, signalPeriod);
  const signal: Series = new Array(values.length).fill(null);
  for (let j = 0; j < denseSignal.length; j++) {
    if (denseSignal[j] !== null) signal[indexMap[j]] = denseSignal[j] as number;
  }
  const histogram: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const m = macdLine[i];
    const s = signal[i];
    if (m === null || s === null) continue;
    histogram[i] = m - s;
  }
  return { macd: macdLine, signal, histogram };
}

/** Wilder-smoothed Average True Range. */
export function atr(candles: readonly Candle[], period = 14): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface DonchianChannels {
  upper: Series;
  lower: Series;
  middle: Series;
}

/** Highest high / lowest low over a trailing window (inclusive of the bar). */
export function donchian(candles: readonly Candle[], period = 20): DonchianChannels {
  const n = candles.length;
  const upper: Series = new Array(n).fill(null);
  const lower: Series = new Array(n).fill(null);
  const middle: Series = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
    middle[i] = (hi + lo) / 2;
  }
  return { upper, lower, middle };
}

/** Highest value of a numeric series over a trailing window. */
export function rollingMax(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, values[j]);
    out[i] = m;
  }
  return out;
}

export function rollingMin(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.min(m, values[j]);
    out[i] = m;
  }
  return out;
}

/** True when `a` crosses above `b` between `i-1` and `i`. */
export function crossOver(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  if (a0 === null || a1 === null || b0 === null || b1 === null) return false;
  return a0 <= b0 && a1 > b1;
}

/** True when `a` crosses below `b` between `i-1` and `i`. */
export function crossUnder(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  if (a0 === null || a1 === null || b0 === null || b1 === null) return false;
  return a0 >= b0 && a1 < b1;
}

export function lastNonNull(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i] as number;
  }
  return null;
}

/** Closing prices from a candle array. */
export function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close);
}
