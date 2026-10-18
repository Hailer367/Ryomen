import { requireBot } from "@/lib/bot/config";
import { getCandles } from "@/lib/market/service";
import { resolveParams } from "@/lib/strategies";
import { requireStrategy } from "@/lib/strategies";
import type { StrategySignal } from "@/lib/strategies/types";

export interface StrategySnapshot {
  strategyId: string;
  name: string;
  category: string;
  description: string;
  philosophy: string;
  weight: number;
  /** True when this strategy is the bot's authoritative signal. */
  primary: boolean;
  params: Record<string, number>;
  /** Every per-bar-size calibration this strategy declares. */
  profiles: { granularity: string; params: Record<string, number>; minCandles: number }[];
  signal: StrategySignal;
  /** How many candles the strategy needed vs. how many we have. */
  ready: boolean;
}

export interface BotSnapshot {
  coinId: string;
  botId: string;
  botName: string;
  enabled: boolean;
  notes: string;
  granularity: string;
  candles: number;
  lastClose: number | null;
  lastCandleTime: number | null;
  risk: {
    maxPositionFraction: number;
    stopLossFraction: number | null;
    takeProfitFraction: number | null;
    signalThreshold: number;
  };
  strategies: StrategySnapshot[];
}

/**
 * Evaluate each of a bot's strategies against the most recent closed candle so
 * the dashboard can show what the bot is thinking right now.
 */
export async function getBotSnapshot(coinId: string): Promise<BotSnapshot> {
  const bot = requireBot(coinId);
  const series = await getCandles(coinId, {
    days: bot.market.days,
    source: bot.market.source,
  });
  const candles = series.candles;
  const index = candles.length - 1;
  const last = candles[index];

  const strategies: StrategySnapshot[] = bot.assignments.map((a) => {
    const strategy = requireStrategy(a.strategyId);
    const params = resolveParams(strategy, a.params ?? {});
    const ready = candles.length > strategy.minCandles;
    const signal: StrategySignal = ready
      ? strategy.evaluate({ coinId, candles, index, position: null, params })
      : { action: "hold", reason: `Warming up (${candles.length}/${strategy.minCandles} candles).`, strength: 0 };
    const profiles = Object.entries(strategy.granularityProfiles ?? {}).map(([granularity, profile]) => ({
      granularity,
      params: resolveParams(strategy, { ...profile.params, ...(a.params ?? {}) }),
      minCandles: profile.minCandles,
    }));
    return {
      strategyId: strategy.id,
      name: strategy.name,
      category: strategy.category,
      description: strategy.description,
      philosophy: strategy.philosophy,
      weight: a.weight,
      primary: a.primary === true,
      params,
      profiles,
      signal,
      ready,
    };
  });

  return {
    coinId,
    botId: bot.id,
    botName: bot.name,
    enabled: bot.enabled,
    notes: bot.notes,
    granularity: series.granularity,
    candles: candles.length,
    lastClose: last?.close ?? null,
    lastCandleTime: last?.time ?? null,
    risk: { ...bot.risk },
    strategies,
  };
}
