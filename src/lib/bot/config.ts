import { COINS } from "@/lib/coins";
import { listStrategies } from "@/lib/strategies";

/**
 * Bot configuration — also permanent code, not user-editable.
 *
 * Every coin gets an independent bot with its own strategy blend, capital
 * allocation and risk envelope. Nothing here is exposed as a write endpoint.
 */

export interface StrategyAssignment {
  strategyId: string;
  /** Relative vote weight when the bot aggregates its strategies. */
  weight: number;
  /**
   * The bot's authoritative strategy. When it emits a directional signal, that
   * signal *is* the decision — other strategies inform confidence but cannot
   * veto it. This is what makes a plain crossover act like a plain crossover.
   */
  primary?: boolean;
  /** Optional parameter overrides, validated against the strategy's bounds. */
  params?: Record<string, number>;
}

export interface BotRisk {
  /** Maximum share of bot equity deployed into a single position (0–1). */
  maxPositionFraction: number;
  /** Hard stop as a fraction below entry. `null` disables. */
  stopLossFraction: number | null;
  /** Take-profit as a fraction above entry. `null` disables. */
  takeProfitFraction: number | null;
  /** Net aggregated vote required before the bot acts (0–1). */
  signalThreshold: number;
}

export interface CoinBot {
  id: string;
  coinId: string;
  name: string;
  enabled: boolean;
  /** Starting USD balance for this bot's own paper account. */
  allocation: number;
  /** Default market-data window used for the dashboard and paper runs. */
  market: { days: number | "max"; source: "ohlc" | "market-chart" };
  assignments: readonly StrategyAssignment[];
  risk: BotRisk;
  notes: string;
}

function bot(
  coinId: string,
  name: string,
  assignments: StrategyAssignment[],
  risk: Partial<BotRisk>,
  notes: string,
  market: { days: number | "max"; source: "ohlc" | "market-chart" } = { days: 90, source: "market-chart" },
): CoinBot {
  return {
    id: `${coinId}-bot`,
    coinId,
    name,
    enabled: true,
    allocation: 10_000,
    market,
    assignments: Object.freeze(assignments.map((a) => Object.freeze({ ...a }))),
    risk: Object.freeze({
      maxPositionFraction: 0.95,
      stopLossFraction: 0.12,
      takeProfitFraction: null,
      signalThreshold: 0.34,
      ...risk,
    }),
    notes,
  };
}

export const BOTS: readonly CoinBot[] = Object.freeze([
  bot(
    "bitcoin",
    "BTC Trend Sentinel",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "macd-trend", weight: 1.0 },
      { strategyId: "donchian-breakout", weight: 0.8 },
    ],
    { stopLossFraction: 0.15, signalThreshold: 0.25 },
    "The deepest market gets the purest trend stack: cross, momentum and breakout confirmation.",
  ),
  bot(
    "ethereum",
    "ETH Beta Engine",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "macd-trend", weight: 0.9 },
      { strategyId: "roc-momentum", weight: 0.7 },
    ],
    { stopLossFraction: 0.15, signalThreshold: 0.25 },
    "Large-cap beta: trend participation with a momentum overlay to time entries.",
  ),
  bot(
    "solana",
    "SOL Breakout Hunter",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "donchian-breakout", weight: 1.0 },
      { strategyId: "roc-momentum", weight: 0.9 },
    ],
    { stopLossFraction: 0.18, signalThreshold: 0.25 },
    "High-beta L1 — favours breakouts, sized a little tighter on risk.",
  ),
  bot(
    "dogecoin",
    "DOGE Exhaustion Trader",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "rsi-reversal", weight: 1.0 },
      { strategyId: "bollinger-reversion", weight: 0.9 },
    ],
    { stopLossFraction: 0.2, signalThreshold: 0.25 },
    "Meme momentum: ride the crossover, fade exhaustion spikes.",
  ),
  bot(
    "binancecoin",
    "BNB Steady Trend",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "macd-trend", weight: 0.9 },
      { strategyId: "roc-momentum", weight: 0.7 },
    ],
    { stopLossFraction: 0.14, signalThreshold: 0.25 },
    "Exchange blue-chip: steady trend capture, calmer risk envelope.",
  ),
  bot(
    "hyperliquid",
    "HYPE Volatility Guard",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "donchian-breakout", weight: 1.0 },
    ],
    { maxPositionFraction: 0.75, stopLossFraction: 0.22, signalThreshold: 0.25 },
    "Young and volatile: reduced position size, wider stops.",
  ),
  bot(
    "tron",
    "TRX Range Trader",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "bollinger-reversion", weight: 1.0 },
      { strategyId: "rsi-reversal", weight: 1.0 },
    ],
    { stopLossFraction: 0.1, signalThreshold: 0.25 },
    "Range asset: crossover to enter, bands and RSI to refine exits.",
  ),
  bot(
    "zcash",
    "ZEC Momentum Cyclical",
    [
      { strategyId: "sma-golden-cross", weight: 1.0, primary: true },
      { strategyId: "volatility-trail", weight: 1.0 },
      { strategyId: "macd-trend", weight: 1.0 },
      { strategyId: "roc-momentum", weight: 0.9 },
    ],
    { stopLossFraction: 0.17, signalThreshold: 0.25 },
    "Privacy-sector cyclical: crossover entry confirmed by momentum.",
  ),
]);

const BY_COIN = new Map(BOTS.map((b) => [b.coinId, b]));

export function getBot(coinId: string): CoinBot | undefined {
  return BY_COIN.get(coinId);
}

export function requireBot(coinId: string): CoinBot {
  const b = BY_COIN.get(coinId);
  if (!b) throw new Error(`No bot configured for coin: ${coinId}`);
  return b;
}

/** The strategy a bot treats as authoritative, if one is designated. */
export function primaryStrategyId(bot: CoinBot): string | undefined {
  return bot.assignments.find((a) => a.primary)?.strategyId;
}

export function listBots(): readonly CoinBot[] {
  return BOTS;
}

/** Validate at import time that every bot references real coins and strategies. */
(function validateBotRegistry() {
  const validCoins = new Set(COINS.map((c) => c.id));
  const validStrategies = new Set(listStrategies().map((s) => s.id));
  for (const b of BOTS) {
    if (!validCoins.has(b.coinId)) throw new Error(`Bot ${b.id} references unknown coin ${b.coinId}`);
    for (const a of b.assignments) {
      if (!validStrategies.has(a.strategyId)) {
        throw new Error(`Bot ${b.id} references unknown strategy ${a.strategyId}`);
      }
    }
  }
})();
