import { NextResponse } from "next/server";
import { listStrategies } from "@/lib/strategies";
import { listBots } from "@/lib/bot/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only catalogue of every permanent strategy and the bots that use them.
 * There is intentionally no POST/PUT/DELETE here: strategies are immutable.
 */
export async function GET() {
  return NextResponse.json({
    strategies: listStrategies().map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      description: s.description,
      philosophy: s.philosophy,
      defaultParams: s.defaultParams,
      paramsMeta: s.paramsMeta,
      minCandles: s.minCandles,
      usedBy: listBots()
        .filter((b) => b.assignments.some((a) => a.strategyId === s.id))
        .map((b) => ({ coinId: b.coinId, botName: b.name, weight: b.assignments.find((a) => a.strategyId === s.id)!.weight })),
    })),
    immutable: true,
  });
}
