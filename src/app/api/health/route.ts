import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { COINS } from "@/lib/coins";
import { STRATEGIES } from "@/lib/strategies";
import { BOTS } from "@/lib/bot/config";
import { getCoinGeckoStats } from "@/lib/market/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  let dbError: string | null = null;
  try {
    getDb().prepare("SELECT 1").get();
    dbOk = true;
  } catch (err) {
    dbError = (err as Error).message;
  }

  return NextResponse.json({
    status: dbOk ? "ok" : "degraded",
    db: { ok: dbOk, error: dbError },
    coingecko: getCoinGeckoStats(),
    coins: COINS.length,
    strategies: STRATEGIES.length,
    bots: BOTS.length,
    mode: "paper",
    liveTradingEnabled: false,
    time: new Date().toISOString(),
  });
}
