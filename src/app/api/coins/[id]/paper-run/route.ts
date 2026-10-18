import { NextResponse } from "next/server";
import { getCoin, isKnownCoin } from "@/lib/coins";
import { requireBot } from "@/lib/bot/config";
import { runPaperTrading } from "@/lib/paper/engine";
import { savePaperRun } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface PaperRunBody {
  /** A session runs exactly one strategy. */
  strategyId?: string;
  /** Legacy shape; must resolve to a single strategy. */
  strategyIds?: string[];
  /** How much history to replay. */
  historyDays?: number;
  source?: "ohlc" | "market-chart";
  startingCash?: number;
  persist?: boolean;
}

const ALLOWED_HISTORY = new Set([14, 30, 60, 90, 180, 365]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isKnownCoin(id)) return NextResponse.json({ error: `Unknown coin: ${id}` }, { status: 404 });

  let body: PaperRunBody = {};
  try {
    body = (await request.json()) as PaperRunBody;
  } catch {
    // Empty body is fine — defaults come from the bot's permanent config.
  }

  const bot = requireBot(id);
  const validStrategyIds = new Set(bot.assignments.map((a) => a.strategyId));

  // Paper sessions run a single strategy, chosen from the ones this bot owns.
  const requested = body.strategyId ?? (Array.isArray(body.strategyIds) ? body.strategyIds[0] : undefined);
  const strategyId = requested ?? validStrategyIds.values().next().value;

  if (!strategyId || !validStrategyIds.has(strategyId)) {
    return NextResponse.json(
      { error: `"${requested}" is not a strategy assigned to the ${id} bot.` },
      { status: 400 },
    );
  }

  if (Array.isArray(body.strategyIds) && body.strategyIds.length > 1) {
    return NextResponse.json(
      { error: "A paper session runs a single strategy. Pick exactly one." },
      { status: 400 },
    );
  }

  try {
    const historyDays =
      typeof body.historyDays === "number" && ALLOWED_HISTORY.has(body.historyDays)
        ? body.historyDays
        : undefined;

    const result = await runPaperTrading({
      coinId: id,
      strategyIds: [strategyId],
      historyDays,
      source: body.source,
      startingCash: body.startingCash ?? bot.allocation,
    });

    let runId: string | null = null;
    if (body.persist !== false) runId = savePaperRun(result);

    return NextResponse.json({
      runId,
      coin: getCoin(id),
      summary: {
        coinId: result.coinId,
        strategyIds: result.strategyIds,
        granularity: result.granularity,
        days: result.days,
        startingCash: result.startingCash,
        finalEquity: result.finalEquity,
        totalReturnPct: result.totalReturnPct,
        maxDrawdownPct: result.maxDrawdownPct,
        winRatePct: result.winRatePct,
        tradeCount: result.tradeCount,
        roundTrips: result.roundTrips,
        sharpe: result.sharpe,
        buyHoldReturnPct: result.buyHoldReturnPct,
        warmupBars: result.warmupBars,
        barSeconds: result.barSeconds,
        candlesUsed: result.candlesUsed,
        startTime: result.startTime,
        endTime: result.endTime,
      },
      replay: {
        candles: result.candles,
        replayStartIndex: result.replayStartIndex,
        replayEndIndex: result.replayEndIndex,
        replayStartTime: result.replayStartTime,
        replayEndTime: result.replayEndTime,
        barSeconds: result.barSeconds,
        warmupBars: result.warmupBars,
      },
      equityCurve: result.equityCurve,
      trades: result.trades,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
