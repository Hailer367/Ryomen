import { aggregateVotes, type StrategyVote } from "@/lib/bot/aggregate";
import { requireBot } from "@/lib/bot/config";
import { config } from "@/lib/config";
import { getCandles } from "@/lib/market/service";
import { GRANULARITY_SECONDS } from "@/lib/market/series";
import { profileFor, requireStrategy, resolveParams } from "@/lib/strategies";
import type { Granularity } from "@/lib/market/types";
import type { Candle } from "@/lib/market/types";
import type { Strategy, StrategyContext, StrategyPosition } from "@/lib/strategies/types";
import {
  buyHoldReturnPct,
  computeMaxDrawdownPct,
  computeSharpe,
  type EquityPoint,
  type PaperRunResult,
  type PaperTrade,
  type SignalLogEntry,
} from "@/lib/paper/types";

export interface RunPaperOptions {
  coinId: string;
  /** Restrict the run to a subset of the bot's strategies. Defaults to all. */
  strategyIds?: string[];
  /** Per-strategy parameter overrides (validated against each strategy's bounds). */
  paramOverrides?: Record<string, Record<string, number>>;
  /** How much history to replay. */
  historyDays?: number | "max";
  source?: "ohlc" | "market-chart";
  startingCash?: number;
  feeBps?: number;
  slippageBps?: number;
  /**
   * Restrict trading to an absolute time window, keeping the warm-up bars that
   * precede it. Used by the optimiser to separate in-sample (tuning) data from
   * out-of-sample (validation) data — tuning and scoring on the same bars would
   * just measure how well the parameters memorised the past.
   */
  window?: { fromTime: number; toTime: number };
  /** Skip the cache and simulate against an already-loaded series. */
  preloadedCandles?: Candle[];
  /** Required alongside `preloadedCandles` so profiles resolve correctly. */
  granularityHint?: Granularity;
}

interface CompiledStrategy {
  strategy: Strategy;
  weight: number;
  params: Record<string, number>;
  minCandles: number;
}

/**
 * Runs a bot's strategy blend over *real historical market data* from
 * CoinGecko — the engine behind Ryomen's paper-trading mode.
 *
 * The replay is deliberately conservative and bar-close driven:
 *  - decisions are made on closed candles only (no look-ahead),
 *  - protective stops are checked against the bar's low/high,
 *  - every fill pays fees and slippage,
 *  - the position is long-only (spot), matching what the bot would do live.
 */
export async function runPaperTrading(options: RunPaperOptions): Promise<PaperRunResult> {
  const bot = requireBot(options.coinId);
  const feeBps = options.feeBps ?? config.paper.feeBps;
  const slippageBps = options.slippageBps ?? config.paper.slippageBps;
  const startingCash = options.startingCash ?? bot.allocation ?? config.paper.startingCash;

  const assignments = bot.assignments.filter(
    (a) => !options.strategyIds || options.strategyIds.includes(a.strategyId),
  );
  if (assignments.length === 0) throw new Error(`No strategies selected for ${options.coinId}`);

  /**
   * A session runs exactly one strategy.
   *
   * Blending several strategies into one vote makes attribution impossible —
   * you can never tell which one caused a trade. One strategy per session means
   * every fill is unambiguously that strategy's doing, which is what matters as
   * the library grows.
   */
  if (assignments.length > 1) {
    throw new Error(
      `A paper session runs a single strategy, but ${assignments.length} were selected ` +
        `(${assignments.map((a) => a.strategyId).join(", ")}). Pick one.`,
    );
  }

  const strategyAssignments = assignments.map((a) => {
    const strategy = requireStrategy(a.strategyId);
    const overrides = { ...(a.params ?? {}), ...(options.paramOverrides?.[a.strategyId] ?? {}) };
    return { strategy, weight: a.weight, overrides };
  });

  const historyDays =
    options.historyDays ?? (typeof bot.market.days === "number" ? bot.market.days : 90);

  /**
   * Budget extra history for the indicator warm-up.
   *
   * Without this the warm-up silently eats into the requested depth: a 30-day
   * request on hourly bars needs 205 warm-up bars (~8.5 days), leaving only ~22
   * days of replay. We fetch `historyDays + warmupDays` and then replay exactly
   * `historyDays`, so the number on screen means what it says.
   */
  const guessedBarSeconds = historyDays === "max" || historyDays > 90 ? 86_400 : 3_600;
  const guessedGranularity: Granularity = guessedBarSeconds === 86_400 ? "1d" : "1h";
  const guessedWarmupBars = strategyAssignments.reduce(
    (m, a) => Math.max(m, profileFor(a.strategy, guessedGranularity).minCandles),
    0,
  );
  const warmupDays = Math.ceil((guessedWarmupBars * guessedBarSeconds) / 86_400) + 2;
  /**
   * CoinGecko caps history by granularity: 90 days of hourly data, 365 days of
   * daily data (anything above returns an error). The fetch must stay inside
   * that ceiling, otherwise a 90-day request that needs 101 days would flip to
   * daily and silently change the resolution the strategies run at.
   */
  const ceilingDays = guessedBarSeconds === 86_400 ? 365 : 90;
  const fetchDays: number | "max" =
    historyDays === "max" ? "max" : Math.min(ceilingDays, historyDays + warmupDays);

  const series = options.preloadedCandles
    ? { candles: options.preloadedCandles, granularity: options.granularityHint ?? "1h" }
    : await getCandles(options.coinId, {
        days: fetchDays,
        source: options.source ?? bot.market.source,
        force: false,
      });

  // Paper trading runs on *closed* history only — never the live, still-forming
  // bar. The bot reaches back through cached data and trades forward.
  const barSeconds = GRANULARITY_SECONDS[series.granularity];
  const now = Math.floor(Date.now() / 1000);
  const candles = series.candles.filter((c) => c.time <= now - barSeconds);

  // Parameters are resolved *after* we know the bar size, so a strategy can
  // calibrate itself (e.g. a wider crossover on hourly bars than on daily).
  const compiled: CompiledStrategy[] = strategyAssignments.map((a) => {
    const profile = profileFor(a.strategy, series.granularity);
    return {
      strategy: a.strategy,
      weight: a.weight,
      params: resolveParams(a.strategy, { ...profile.params, ...a.overrides }),
      minCandles: profile.minCandles,
    };
  });
  const warmup = compiled.reduce((m, c) => Math.max(m, c.minCandles), 0);

  // The one selected strategy is authoritative — its signal *is* the decision,
  // with no vote to be outvoted by.
  const activePrimaryId: string | undefined = compiled[0]?.strategy.id;
  const sessionStrategyName = compiled[0]?.strategy.name ?? "strategy";

  if (candles.length < warmup + 3) {
    throw new Error(
      `Insufficient history for ${options.coinId}: ${candles.length} closed candles, need ${warmup + 3} ` +
        `for ${series.granularity} bars. Widen the history window or pick fewer strategies.`,
    );
  }

  // Replay exactly the requested depth, starting after the warm-up.
  let replayStartIndex = warmup;
  const requestedBars =
    historyDays === "max" ? candles.length - warmup : Math.ceil((historyDays * 86_400) / barSeconds);
  let replayEndIndex = Math.min(candles.length - 1, replayStartIndex + requestedBars);

  if (options.window) {
    // Trade only inside the window; warm-up bars before it still count.
    const { fromTime, toTime } = options.window;
    let firstInWindow = candles.findIndex((c) => c.time >= fromTime);
    if (firstInWindow < 0) firstInWindow = candles.length - 1;
    let lastInWindow = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= toTime) {
        lastInWindow = i;
        break;
      }
    }
    replayStartIndex = Math.max(warmup, firstInWindow);
    replayEndIndex = Math.min(lastInWindow, candles.length - 1);
    if (replayEndIndex < 0) {
      throw new Error(`No candles inside the requested window for ${options.coinId}.`);
    }
  }

  if (replayEndIndex - replayStartIndex < 3) {
    throw new Error(`Not enough tradeable history for ${options.coinId} at ${historyDays} days.`);
  }

  const feeRate = feeBps / 10_000;
  const slip = slippageBps / 10_000;

  let cash = startingCash;

  // Held in an object so TypeScript re-widens the nullable levels after the
  // helper closures below mutate them.
  const pos = {
    qty: 0,
    entryPrice: 0,
    entryTime: 0,
    costBasis: 0,
    stopPrice: null as number | null,
    takeProfitPrice: null as number | null,
  };

  const trades: PaperTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const signalLog: SignalLogEntry[] = [];
  const roundTripPnls: number[] = [];

  const markEquity = (close: number) => cash + pos.qty * close;

  const enter = (price: number, time: number, reason: string, signalStop?: number, signalTp?: number) => {
    const notional = markEquity(price) * bot.risk.maxPositionFraction;
    if (notional <= 0) return;

    const fill = price * (1 + slip);
    const desiredQty = notional / fill;
    const desiredCost = desiredQty * fill * (1 + feeRate);
    // Scale down if we cannot afford the full position including fees.
    const quantity = desiredCost > cash ? cash / (fill * (1 + feeRate)) : desiredQty;
    if (quantity <= 0) return;

    const fee = quantity * fill * feeRate;
    cash -= quantity * fill + fee;

    pos.qty = quantity;
    pos.entryPrice = fill;
    pos.entryTime = time;
    pos.costBasis = quantity * fill + fee;
    pos.stopPrice =
      signalStop ?? (bot.risk.stopLossFraction !== null ? fill * (1 - bot.risk.stopLossFraction) : null);
    pos.takeProfitPrice =
      signalTp ?? (bot.risk.takeProfitFraction !== null ? fill * (1 + bot.risk.takeProfitFraction) : null);

    trades.push({
      side: "buy",
      time,
      price: fill,
      qty: quantity,
      fee,
      pnl: null,
      equityAfter: cash + quantity * price,
      reason,
    });
  };

  const exit = (price: number, time: number, reason: string) => {
    if (pos.qty <= 0) return;
    const fill = price * (1 - slip);
    const gross = pos.qty * fill;
    const fee = gross * feeRate;
    const proceeds = gross - fee;
    cash += proceeds;

    const pnl = proceeds - pos.costBasis;
    roundTripPnls.push(pnl);

    trades.push({
      side: "sell",
      time,
      price: fill,
      qty: pos.qty,
      fee,
      pnl,
      equityAfter: cash,
      reason,
    });

    pos.qty = 0;
    pos.entryPrice = 0;
    pos.entryTime = 0;
    pos.costBasis = 0;
    pos.stopPrice = null;
    pos.takeProfitPrice = null;
  };

  for (let i = 0; i <= replayEndIndex; i++) {
    const bar = candles[i];

    // 1. Protective exits fire intrabar, before any new decision.
    if (pos.qty > 0) {
      const stop = pos.stopPrice;
      const take = pos.takeProfitPrice;
      if (stop !== null && bar.low <= stop) {
        exit(
          Math.min(stop, bar.open),
          bar.time,
          `${sessionStrategyName}: stop-loss hit at ${stop.toFixed(2)}.`,
        );
      } else if (take !== null && bar.high >= take) {
        exit(
          Math.max(take, bar.open),
          bar.time,
          `${sessionStrategyName}: take-profit hit at ${take.toFixed(2)}.`,
        );
      }
    }

    // 2. Strategy evaluation on the closed bar.
    if (i >= warmup) {
      const position: StrategyPosition | null =
        pos.qty > 0 ? { qty: pos.qty, entryPrice: pos.entryPrice, entryTime: pos.entryTime } : null;

      const votes: StrategyVote[] = compiled.map((c) => {
        const ctx: StrategyContext = {
          coinId: options.coinId,
          candles,
          index: i,
          position,
          params: c.params,
        };
        return {
          strategyId: c.strategy.id,
          strategyName: c.strategy.name,
          category: c.strategy.category,
          weight: c.weight,
          signal: c.strategy.evaluate(ctx),
        };
      });

      const decision = aggregateVotes(votes, {
        threshold: bot.risk.signalThreshold,
        isLong: pos.qty > 0,
        primaryStrategyId: activePrimaryId,
      });

      if (decision.action === "buy" && pos.qty === 0) {
        enter(bar.close, bar.time, decision.reason, decision.stopLossPrice, decision.takeProfitPrice);
        signalLog.push({
          time: bar.time,
          action: "buy",
          score: decision.score,
          reason: decision.reason,
          votes: votes.map(slim),
        });
      } else if (decision.action === "sell" && pos.qty > 0) {
        exit(bar.close, bar.time, decision.reason);
        signalLog.push({
          time: bar.time,
          action: "sell",
          score: decision.score,
          reason: decision.reason,
          votes: votes.map(slim),
        });
      }
    }

    if (i >= warmup) {
      equityCurve.push({ time: bar.time, equity: markEquity(bar.close) });
    }
  }

  // Mark-to-market any open position and close the books.
  const lastBar = candles[replayEndIndex];
  const finalEquity = markEquity(lastBar.close);
  const wins = roundTripPnls.filter((p) => p > 0).length;

  return {
    coinId: options.coinId,
    strategyIds: compiled.map((c) => c.strategy.id),
    granularity: series.granularity,
    days: historyDays,
    startingCash,
    finalEquity,
    totalReturnPct: ((finalEquity - startingCash) / startingCash) * 100,
    maxDrawdownPct: computeMaxDrawdownPct(equityCurve),
    winRatePct: roundTripPnls.length === 0 ? 0 : (wins / roundTripPnls.length) * 100,
    tradeCount: trades.length,
    roundTrips: roundTripPnls.length,
    sharpe: computeSharpe(equityCurve, series.granularity),
    buyHoldReturnPct: buyHoldReturnPct(candles.slice(replayStartIndex, replayEndIndex + 1)),
    equityCurve,
    trades,
    signalLog,
    candlesUsed: replayEndIndex - replayStartIndex + 1,
    startTime: candles[0].time,
    endTime: candles[replayEndIndex].time,
    candles,
    replayStartIndex,
    replayEndIndex,
    replayStartTime: candles[replayStartIndex].time,
    replayEndTime: candles[replayEndIndex].time,
    barSeconds,
    warmupBars: warmup,
  };
}

function slim(v: StrategyVote) {
  return {
    strategyId: v.strategyId,
    action: v.signal.action,
    strength: Number(v.signal.strength.toFixed(3)),
    reason: v.signal.reason,
  };
}
