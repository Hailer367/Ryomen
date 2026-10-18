import type { Candle, Granularity } from "@/lib/market/types";

/** A strategy can only ever ask to go long, flatten, or wait. */
export type SignalAction = "buy" | "sell" | "hold";

/** Open long position, as seen by a strategy at evaluation time. */
export interface StrategyPosition {
  qty: number;
  entryPrice: number;
  entryTime: number;
}

export interface StrategyContext {
  coinId: string;
  /** Full candle history, ascending. */
  candles: readonly Candle[];
  /** Index of the last **closed** candle to evaluate on. */
  index: number;
  /** Current open position, or null when flat. */
  position: StrategyPosition | null;
  /** Validated parameters (merged defaults + assignment overrides). */
  params: Readonly<Record<string, number>>;
}

export interface StrategySignal {
  action: SignalAction;
  /** Human-readable justification, surfaced in the dashboard signal feed. */
  reason: string;
  /** Confidence in [0, 1]. Used to weight votes when a bot runs several strategies. */
  strength: number;
  /** Optional protective levels the paper engine will honour. */
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface StrategyParamMeta {
  key: string;
  label: string;
  /** Inclusive bounds the parameter may be overridden within. */
  min?: number;
  max?: number;
}

/**
 * Per-bar-size calibration.
 *
 * The same rule behaves very differently at different resolutions: an SMA(20/50)
 * cross is a calm swing signal on daily bars but whipsaws into the ground on
 * hourly ones. A strategy can therefore declare tuned periods and warm-up for
 * the granularities it is commonly run at, and the engine picks the right one.
 */
export interface GranularityProfile {
  params: Record<string, number>;
  minCandles: number;
}

export interface Strategy {
  /** Stable identifier. Never change once shipped — it keys trade history. */
  readonly id: string;
  readonly name: string;
  /** Grouping used by the dashboard, e.g. "Trend", "Mean Reversion". */
  readonly category: string;
  readonly description: string;
  readonly philosophy: string;
  readonly defaultParams: Readonly<Record<string, number>>;
  readonly paramsMeta: readonly StrategyParamMeta[];
  /**
   * Restrict this strategy to specific assets. Omit to allow it on any coin the
   * bot owns. Asset-specific strategies (e.g. BTC-only) exist because some
   * patterns genuinely only hold on one market.
   */
  readonly coins?: readonly string[];
  /** Minimum number of candles required before the strategy can fire. */
  readonly minCandles: number;
  /** Optional per-bar-size calibration, keyed by granularity. */
  readonly granularityProfiles?: Readonly<Partial<Record<Granularity, GranularityProfile>>>;
  /**
   * Pure function of its context. Called once per closed candle by the engine.
   * Must not perform I/O or mutate the context.
   */
  evaluate(ctx: StrategyContext): StrategySignal;
}

export function hold(reason: string): StrategySignal {
  return { action: "hold", reason, strength: 0 };
}

export function buy(reason: string, strength: number, extra: Partial<StrategySignal> = {}): StrategySignal {
  return { action: "buy", reason, strength, ...extra };
}

export function sell(reason: string, strength: number, extra: Partial<StrategySignal> = {}): StrategySignal {
  return { action: "sell", reason, strength, ...extra };
}
