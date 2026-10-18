import type { Candle, Granularity } from "@/lib/market/types";

export interface PaperTrade {
  side: "buy" | "sell";
  time: number;
  price: number;
  qty: number;
  fee: number;
  pnl: number | null;
  equityAfter: number;
  reason: string;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface SignalLogEntry {
  time: number;
  action: "buy" | "sell";
  score: number;
  reason: string;
  votes: { strategyId: string; action: string; strength: number; reason: string }[];
}

export interface PaperRunResult {
  coinId: string;
  strategyIds: string[];
  granularity: Granularity;
  days: number | "max";
  startingCash: number;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  tradeCount: number;
  roundTrips: number;
  sharpe: number | null;
  buyHoldReturnPct: number;
  equityCurve: EquityPoint[];
  trades: PaperTrade[];
  signalLog: SignalLogEntry[];
  candlesUsed: number;
  startTime: number;
  endTime: number;
  /* ── Replay ────────────────────────────────────────────────────────── */
  /** Full candle history the run evaluated, oldest first. */
  candles: Candle[];
  /** Index into `candles` where trading (and the replay) begins. */
  replayStartIndex: number;
  /** Index into `candles` where the replay ends, inclusive. */
  replayEndIndex: number;
  replayStartTime: number;
  replayEndTime: number;
  /** Seconds per bar, used to pace playback. */
  barSeconds: number;
  /** Bars consumed by indicator warm-up before trading could begin. */
  warmupBars: number;
}

/** Approximate number of bars in a year for annualising Sharpe. */
export function barsPerYear(granularity: Granularity): number {
  switch (granularity) {
    case "5m":
      return 105_120;
    case "30m":
      return 17_520;
    case "1h":
      return 8_760;
    case "4h":
      return 2_190;
    case "1d":
      return 365;
  }
}

export function computeSharpe(equityCurve: readonly EquityPoint[], granularity: Granularity): number | null {
  if (equityCurve.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev <= 0) continue;
    returns.push(equityCurve[i].equity / prev - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (mean / sd) * Math.sqrt(barsPerYear(granularity));
}

export function computeMaxDrawdownPct(equityCurve: readonly EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = ((peak - p.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

export function buyHoldReturnPct(candles: readonly Candle[]): number {
  if (candles.length < 2) return 0;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  return ((last - first) / first) * 100;
}
