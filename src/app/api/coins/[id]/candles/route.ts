import { NextResponse } from "next/server";
import { isKnownCoin } from "@/lib/coins";
import { getCandles } from "@/lib/market/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED_DAYS = new Set(["1", "7", "14", "30", "90", "180", "365", "max"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isKnownCoin(id)) return NextResponse.json({ error: `Unknown coin: ${id}` }, { status: 404 });

  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days") ?? "90";
  const days = daysParam === "max" ? "max" : ALLOWED_DAYS.has(daysParam) ? Number(daysParam) : 90;
  const source = url.searchParams.get("source") === "market-chart" ? "market-chart" : "ohlc";
  const force = url.searchParams.get("force") === "1";

  try {
    const series = await getCandles(id, { days, source, force });
    return NextResponse.json({
      coinId: id,
      granularity: series.granularity,
      days,
      source: series.source,
      candles: series.candles,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, candles: [] }, { status: 502 });
  }
}
