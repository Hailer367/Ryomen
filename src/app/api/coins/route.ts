import { NextResponse } from "next/server";
import { COINS } from "@/lib/coins";
import { listBots } from "@/lib/bot/config";
import { getTickers } from "@/lib/market/service";
import { latestRunPerCoin } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const [tickers] = await Promise.all([getTickers({ force })]);
  const tickerById = new Map(tickers.map((t) => [t.coinId, t]));
  const bots = new Map(listBots().map((b) => [b.coinId, b]));
  const latestRuns = latestRunPerCoin();

  const coins = COINS.map((coin) => {
    const t = tickerById.get(coin.id);
    const bot = bots.get(coin.id);
    const run = latestRuns.get(coin.id);
    return {
      ...coin,
      priceUsd: t?.priceUsd ?? null,
      change24hPct: t?.change24hPct ?? null,
      marketCapUsd: t?.marketCapUsd ?? null,
      volume24hUsd: t?.volume24hUsd ?? null,
      updatedAt: t?.updatedAt ?? null,
      botName: bot?.name ?? null,
      strategyCount: bot?.assignments.length ?? 0,
      latestRun: run ?? null,
    };
  });

  return NextResponse.json({ coins, generatedAt: Date.now() });
}
