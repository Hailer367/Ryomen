import Link from "next/link";
import { notFound } from "next/navigation";
import { getCoin } from "@/lib/coins";
import { getBotSnapshot } from "@/lib/bot/signals";
import { getTickers } from "@/lib/market/service";
import { listRuns, type PaperRunSummary } from "@/lib/paper/store";
import { CoinWorkspace, type BotSnapshotDTO, type RunSummaryDTO } from "@/components/CoinWorkspace";

export const dynamic = "force-dynamic";

function serialiseRun(r: PaperRunSummary): RunSummaryDTO {
  return {
    id: r.id,
    coinId: r.coinId,
    strategyIds: r.strategyIds,
    granularity: r.granularity,
    days: r.days,
    startingCash: r.startingCash,
    finalEquity: r.finalEquity,
    totalReturnPct: r.totalReturnPct,
    maxDrawdownPct: r.maxDrawdownPct,
    winRatePct: r.winRatePct,
    tradeCount: r.tradeCount,
    roundTrips: r.roundTrips,
    candlesUsed: r.candlesUsed,
    startTime: r.startTime,
    endTime: r.endTime,
    sharpe: r.sharpe,
    buyHoldReturnPct: r.buyHoldReturnPct,
    warmupBars: r.warmupBars,
    barSeconds: r.barSeconds,
    createdAt: r.createdAt,
  };
}

export default async function CoinPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = getCoin(id);
  if (!coin) notFound();

  const runs = listRuns(id, 20).map(serialiseRun);

  let bot: BotSnapshotDTO | null = null;
  let snapshotError: string | null = null;
  let ticker = null;

  try {
    const [snapshot, tickers] = await Promise.all([getBotSnapshot(id), getTickers()]);
    bot = snapshot as BotSnapshotDTO;
    const t = tickers.find((x) => x.coinId === id) ?? null;
    ticker = t
      ? {
          priceUsd: t.priceUsd,
          change24hPct: t.change24hPct,
          marketCapUsd: t.marketCapUsd,
          volume24hUsd: t.volume24hUsd,
          updatedAt: t.updatedAt,
        }
      : null;
  } catch (err) {
    snapshotError = (err as Error).message;
  }

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">Overview</Link> <span style={{ margin: "0 6px" }}>/</span> {coin.name}
      </div>

      {bot ? (
        <CoinWorkspace coin={coin} bot={bot} initialRuns={runs} ticker={ticker} />
      ) : (
        <div className="notice notice-error">
          Could not load the {coin.symbol} bot snapshot: {snapshotError}. CoinGecko&apos;s free tier is rate limited —
          wait a moment and refresh.
        </div>
      )}
    </>
  );
}
