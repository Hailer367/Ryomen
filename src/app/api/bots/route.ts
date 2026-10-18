import { NextResponse } from "next/server";
import { getCoin } from "@/lib/coins";
import { listBots } from "@/lib/bot/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    bots: listBots().map((b) => ({
      id: b.id,
      coinId: b.coinId,
      coin: getCoin(b.coinId) ?? null,
      name: b.name,
      enabled: b.enabled,
      allocation: b.allocation,
      market: b.market,
      risk: b.risk,
      notes: b.notes,
      assignments: b.assignments.map((a) => ({ strategyId: a.strategyId, weight: a.weight, params: a.params ?? {} })),
    })),
  });
}
