import { NextResponse } from "next/server";
import { getCoin } from "@/lib/coins";
import { getBotSnapshot } from "@/lib/bot/signals";
import { getTickers } from "@/lib/market/service";
import { listRuns } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = getCoin(id);
  if (!coin) return NextResponse.json({ error: `Unknown coin: ${id}` }, { status: 404 });

  try {
    const [snapshot, tickers] = await Promise.all([getBotSnapshot(id), getTickers()]);
    const ticker = tickers.find((t) => t.coinId === id) ?? null;
    return NextResponse.json({
      coin,
      ticker,
      bot: snapshot,
      runs: listRuns(id, 25),
    });
  } catch (err) {
    return NextResponse.json(
      { coin, bot: null, ticker: null, runs: listRuns(id, 25), error: (err as Error).message },
      { status: 200 },
    );
  }
}
