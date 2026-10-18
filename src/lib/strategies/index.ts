import {
  bollingerReversion,
  donchianBreakout,
  macdTrend,
  rsiReversal,
  rocMomentum,
  smaGoldenCross,
  volatilityTrail,
} from "@/lib/strategies/builtin";
import type { Granularity } from "@/lib/market/types";
import type { GranularityProfile, Strategy } from "@/lib/strategies/types";

/**
 * Pick a strategy's calibration for the bar size it is about to run on,
 * falling back to its declared defaults.
 */
export function profileFor(strategy: Strategy, granularity: Granularity): GranularityProfile {
  return (
    strategy.granularityProfiles?.[granularity] ?? {
      params: { ...strategy.defaultParams },
      minCandles: strategy.minCandles,
    }
  );
}

/**
 * The permanent strategy catalogue.
 *
 * Ryomen's strategies are code, not configuration. They are defined once here,
 * deep-frozen, and the dashboard only ever *reads* them — there is no create,
 * edit, or delete path anywhere in the application.
 */
export const STRATEGIES: readonly Strategy[] = Object.freeze([
  smaGoldenCross,
  volatilityTrail,
  donchianBreakout,
  macdTrend,
  rocMomentum,
  bollingerReversion,
  rsiReversal,
]);

const BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

const duplicate = STRATEGIES.map((s) => s.id).find((id, i, arr) => arr.indexOf(id) !== i);
if (duplicate) throw new Error(`Duplicate strategy id registered: ${duplicate}`);

export function getStrategy(id: string): Strategy | undefined {
  return BY_ID.get(id);
}

export function requireStrategy(id: string): Strategy {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}

export function listStrategies(): readonly Strategy[] {
  return STRATEGIES;
}

/** Merge a strategy's defaults with a validated override map. */
export function resolveParams(strategy: Strategy, overrides: Record<string, number> = {}): Record<string, number> {
  const params: Record<string, number> = { ...strategy.defaultParams };
  for (const meta of strategy.paramsMeta) {
    const value = overrides[meta.key];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) continue;
    if (meta.min !== undefined && value < meta.min) continue;
    if (meta.max !== undefined && value > meta.max) continue;
    params[meta.key] = value;
  }
  return params;
}

export type { Strategy, StrategySignal, StrategyContext, SignalAction } from "@/lib/strategies/types";
