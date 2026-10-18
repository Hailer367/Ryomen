/**
 * Characterise an asset's price behaviour before designing a strategy for it.
 *
 *   npx tsx scripts/analyze.ts ethereum
 *
 * Choosing a strategy family from intuition is how you end up running a BTC
 * momentum system on an asset that mean-reverts. This measures the two things
 * that decide the family:
 *
 *   - return autocorrelation: positive => trends, negative => reverts
 *   - how much a naive trend-follower vs a naive mean-reverter would have made
 */
import { closeDb, getDb } from "../src/lib/db/index";
import type { Candle, Granularity } from "../src/lib/market/types";

const COIN = process.argv[2] ?? "ethereum";
const GRAN: Granularity = "1h";

function load(coinId: string, granularity: Granularity): Candle[] {
  return getDb()
    .prepare(`SELECT time, open, high, low, close FROM candles WHERE coin_id = ? AND granularity = ? ORDER BY time ASC`)
    .all(coinId, granularity) as Candle[];
}

function autocorr(closes: number[], lag: number): number {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = lag; i < r.length; i++) {
    const a = r[i] - mean;
    const b = r[i - lag] - mean;
    num += a * b;
    d1 += a * a;
    d2 += b * b;
  }
  return num / Math.sqrt(d1 * d2);
}

/** Buy-and-hold, but only while price is above its N-bar average. */
function trendFollower(closes: number[], period: number): { ret: number; exposure: number } {
  let cash = 1;
  let pos = 0;
  let peakCash = 1;
  let exposureBars = 0;
  for (let i = 1; i < closes.length; i++) {
    if (i < period) continue;
    let sum = 0;
    for (let j = i - period; j <= i; j++) sum += closes[j];
    const ma = sum / (period + 1);
    const wantLong = closes[i] > ma;
    if (wantLong && pos === 0) {
      pos = cash / closes[i];
      cash = 0;
    } else if (!wantLong && pos > 0) {
      cash = pos * closes[i];
      pos = 0;
    }
    if (pos > 0) exposureBars += 1;
    peakCash = Math.max(peakCash, cash + pos * closes[i]);
  }
  const final = cash + pos * closes[closes.length - 1];
  return { ret: (final - 1) * 100, exposure: exposureBars / (closes.length - period) };
}

/**
 * Buy dips: long below the moving average, flat above it.
 * Long-only, matching spot semantics — shorting here would just measure a
 * short-selling strategy the bot cannot actually run.
 */
function meanReverter(closes: number[], period: number): { ret: number; exposure: number } {
  let cash = 1;
  let pos = 0;
  let exposureBars = 0;
  for (let i = 1; i < closes.length; i++) {
    if (i < period) continue;
    let sum = 0;
    for (let j = i - period; j <= i; j++) sum += closes[j];
    const ma = sum / (period + 1);
    const dev = (closes[i] - ma) / ma;
    if (dev < -0.005 && pos === 0) {
      pos = cash / closes[i];
      cash = 0;
    } else if (dev > 0.005 && pos > 0) {
      cash = pos * closes[i];
      pos = 0;
    }
    if (pos > 0) exposureBars += 1;
  }
  const final = cash + pos * closes[closes.length - 1];
  return { ret: (final - 1) * 100, exposure: exposureBars / (closes.length - period) };
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function main() {
  for (const gran of ["1h", "1d"] as Granularity[]) {
    const cs = load(COIN, gran);
    if (cs.length < 120) continue;
    const closes = cs.map((c) => c.close);

    console.log(`\n══ ${COIN} @ ${gran} — ${cs.length} bars ══`);

    console.log("\n  return autocorrelation (positive = trends, negative = reverts)");
    for (const lag of [1, 3, 6, 12, 24]) {
      if (lag >= closes.length) continue;
      const a = autocorr(closes, lag);
      const bar = "█".repeat(Math.min(30, Math.round(Math.abs(a) * 60)));
      console.log(
        `    lag ${String(lag).padStart(2)} : ${a >= 0 ? " " : ""}${a.toFixed(3)} ${a > 0 ? "trend " : "revert"} ${bar}`,
      );
    }

    const logrets: number[] = [];
    for (let i = 1; i < closes.length; i++) logrets.push(Math.log(closes[i] / closes[i - 1]));
    const sd = stdev(logrets);
    console.log(`\n  hourly/daily vol : ${(sd * 100).toFixed(2)}% per bar`);
    console.log(`  total move       : ${(((closes[closes.length - 1] / closes[0]) - 1) * 100).toFixed(2)}%`);
    console.log(`  max drawdown     : ${maxDd(closes).toFixed(2)}%`);

    console.log("\n  naive systems (gross of fees), same window");
    console.log("    period    trend-follow    mean-revert");
    for (const period of [10, 20, 50, 100]) {
      if (period >= closes.length - 2) continue;
      const tf = trendFollower(closes, period);
      const mr = meanReverter(closes, period);
      console.log(
        `    ${String(period).padStart(5)}   ${tf.ret.toFixed(1).padStart(8)}% (in ${(tf.exposure * 100).toFixed(0)}%)` +
          `   ${mr.ret.toFixed(1).padStart(8)}% (in ${(mr.exposure * 100).toFixed(0)}%)`,
      );
    }
  }
  console.log("");
  closeDb();
}

function maxDd(closes: number[]): number {
  let peak = closes[0];
  let dd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    dd = Math.max(dd, ((peak - c) / peak) * 100);
  }
  return dd;
}

main();
