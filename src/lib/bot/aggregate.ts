import type { StrategySignal, SignalAction } from "@/lib/strategies/types";

export interface StrategyVote {
  strategyId: string;
  strategyName: string;
  category: string;
  weight: number;
  signal: StrategySignal;
}

export interface AggregatedDecision {
  action: SignalAction;
  /** Normalised net vote in [-1, 1]. */
  score: number;
  reason: string;
  votes: StrategyVote[];
  stopLossPrice?: number;
  takeProfitPrice?: number;
  /** True when the bot's primary strategy decided this on its own. */
  primaryDriven?: boolean;
}

/**
 * Decide whether Ryomen acts this bar.
 *
 * A bot's **primary strategy is authoritative**: if it emits a directional
 * signal, that signal is the decision. The remaining strategies are secondary
 * voices — they modulate confidence, but they cannot veto the primary call.
 *
 * Without this, a single strategy on a three-strategy bot carries only 1/3 of
 * the vote and a clean crossover can never clear the threshold on its own.
 */
export function aggregateVotes(
  votes: readonly StrategyVote[],
  options: { threshold: number; isLong: boolean; primaryStrategyId?: string },
): AggregatedDecision {
  const totalWeight = votes.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight === 0) {
    return { action: "hold", score: 0, reason: "No enabled strategies.", votes: [...votes] };
  }

  let score = 0;
  for (const v of votes) {
    const dir = v.signal.action === "buy" ? 1 : v.signal.action === "sell" ? -1 : 0;
    score += dir * v.signal.strength * v.weight;
  }
  const normalized = score / totalWeight;

  const bulls = votes.filter((v) => v.signal.action === "buy");
  const bears = votes.filter((v) => v.signal.action === "sell");

  const stopLossPrice = bulls.find((v) => v.signal.stopLossPrice !== undefined)?.signal.stopLossPrice;
  const takeProfitPrice = bulls.find((v) => v.signal.takeProfitPrice !== undefined)?.signal.takeProfitPrice;

  const { threshold, isLong, primaryStrategyId } = options;

  // ── Primary strategy decides ───────────────────────────────────────────
  const primary = primaryStrategyId ? votes.find((v) => v.strategyId === primaryStrategyId) : undefined;
  if (primary && primary.signal.action !== "hold") {
    const wanted = primary.signal.action;
    const permitted = wanted === "buy" ? !isLong : isLong;
    if (permitted) {
      return {
        action: wanted,
        score: normalized,
        reason: `${primary.strategyName}: ${primary.signal.reason}`,
        votes: [...votes],
        stopLossPrice,
        takeProfitPrice,
        primaryDriven: true,
      };
    }
  }

  // ── Otherwise: weighted vote ───────────────────────────────────────────
  if (!isLong && normalized >= threshold) {
    return {
      action: "buy",
      score: normalized,
      reason: bulls.map((v) => `${v.strategyName}: ${v.signal.reason}`).join(" | ") || "Net bullish vote.",
      votes: [...votes],
      stopLossPrice,
      takeProfitPrice,
    };
  }

  if (isLong && normalized <= -threshold) {
    return {
      action: "sell",
      score: normalized,
      reason: bears.map((v) => `${v.strategyName}: ${v.signal.reason}`).join(" | ") || "Net bearish vote.",
      votes: [...votes],
      stopLossPrice,
      takeProfitPrice,
    };
  }

  return {
    action: "hold",
    score: normalized,
    reason: `Net vote ${(normalized * 100).toFixed(0)}% (threshold ±${(threshold * 100).toFixed(0)}%) — staying ${
      isLong ? "long" : "flat"
    }.`,
    votes: [...votes],
  };
}
