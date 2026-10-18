import Link from "next/link";
import { COINS } from "@/lib/coins";
import { listBots } from "@/lib/bot/config";
import { listStrategies } from "@/lib/strategies";
import { getTickers } from "@/lib/market/service";
import { latestRunPerCoin } from "@/lib/paper/store";
import { changeClass, formatPct, formatUsd, timeAgo } from "@/lib/format";
import { RunAllBots } from "@/components/RunAllBots";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const tickers = await getTickers();
  const tickerById = new Map(tickers.map((t) => [t.coinId, t]));
  const bots = new Map(listBots().map((b) => [b.coinId, b]));
  const strategies = new Map(listStrategies().map((s) => [s.id, s]));
  const latestRuns = latestRunPerCoin();
  const anyTicker = tickers.length > 0;

  return (
    <>
      <h1 className="page-title">Bot Fleet</h1>
      <p className="page-sub">
        Eight independent bots, each with its own permanent strategy blend. No manual trading — every action is
        produced by the strategy engine.
      </p>

      <div className="metrics" style={{ marginBottom: 24 }}>
        <div className="metric">
          <div className="metric-label">Active Bots</div>
          <div className="metric-value">{COINS.length}</div>
          <div className="metric-hint">one per asset</div>
        </div>
        <div className="metric">
          <div className="metric-label">Strategy Library</div>
          <div className="metric-value">{listStrategies().length}</div>
          <div className="metric-hint">permanent, code-defined</div>
        </div>
        <div className="metric">
          <div className="metric-label">Execution</div>
          <div className="metric-value" style={{ fontSize: 16, color: "var(--amber)" }}>
            Paper
          </div>
          <div className="metric-hint">live trading stubbed</div>
        </div>
        <div className="metric">
          <div className="metric-label">Market Data</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            CoinGecko
          </div>
          <div className="metric-hint">{anyTicker ? `updated ${timeAgo(tickers[0]?.updatedAt)}` : "no data cached yet"}</div>
        </div>
      </div>

      {!anyTicker && (
        <div className="notice notice-warn" style={{ marginBottom: 18 }}>
          No price snapshots cached yet. CoinGecko&apos;s free tier rate-limits aggressively, so the first refresh can
          take a moment. Open a coin dashboard to warm the cache.
        </div>
      )}

      <div className="panel-head">
        <h3 className="section-title" style={{ margin: 0 }}>
          Assets
        </h3>
        <RunAllBots coins={COINS.map((c) => ({ id: c.id, symbol: c.symbol }))} />
      </div>

      <div className="grid-coins">
        {COINS.map((coin) => {
          const t = tickerById.get(coin.id);
          const bot = bots.get(coin.id);
          const run = latestRuns.get(coin.id);
          return (
            <Link key={coin.id} href={`/coins/${coin.id}`} className="coin-card">
              <div className="coin-card-head">
                <div className="coin-avatar" style={{ background: coin.color }}>
                  {coin.symbol.slice(0, 3)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="coin-name">{coin.name}</div>
                  <div className="coin-sym">{coin.symbol}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="coin-price mono">{formatUsd(t?.priceUsd ?? null, { compact: true })}</div>
                  <div className={`mono ${changeClass(t?.change24hPct)}`} style={{ fontSize: 12, fontWeight: 600 }}>
                    {formatPct(t?.change24hPct ?? null)}
                  </div>
                </div>
              </div>

              {bot && (
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 2 }}>
                  <span style={{ color: "var(--text-faint)" }}>Bot:</span> {bot.name}
                </div>
              )}

              <div className="chips">
                {bot?.assignments.map((a) => (
                  <span key={a.strategyId} className="chip" title={strategies.get(a.strategyId)?.description}>
                    {strategies.get(a.strategyId)?.name ?? a.strategyId}
                  </span>
                ))}
              </div>

              <div className="stat-row">
                <div className="stat">
                  <div className="stat-label">Last Paper Run</div>
                  <div className={`stat-value mono ${run ? changeClass(run.totalReturnPct) : "dim"}`}>
                    {run ? formatPct(run.totalReturnPct) : "never run"}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Win Rate</div>
                  <div className={`stat-value mono ${run ? "" : "dim"}`}>
                    {run ? `${run.winRatePct.toFixed(0)}%` : "—"}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Round Trips</div>
                  <div className={`stat-value mono ${run ? "" : "dim"}`}>{run ? run.roundTrips : "—"}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
