"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CandleChart, type ChartCandle, type ChartMarker, type ChartOverlay } from "@/components/CandleChart";
import { EquityChart, type EquityPoint } from "@/components/EquityChart";
import { changeClass, formatDateTime, formatPct, formatUsd, timeAgo } from "@/lib/format";
import { sma } from "@/lib/indicators";
import { GRANULARITY_SECONDS } from "@/lib/market/series";
import type { Granularity } from "@/lib/market/types";
import { TradeConfigModal, type TradeConfig } from "@/components/TradeConfigModal";

export interface StrategySnapshotDTO {
  strategyId: string;
  name: string;
  category: string;
  description: string;
  philosophy: string;
  weight: number;
  primary: boolean;
  params: Record<string, number>;
  profiles: { granularity: string; params: Record<string, number>; minCandles: number }[];
  signal: { action: "buy" | "sell" | "hold"; reason: string; strength: number };
  ready: boolean;
}

export interface BotSnapshotDTO {
  coinId: string;
  botId: string;
  botName: string;
  notes: string;
  granularity: string;
  candles: number;
  lastClose: number | null;
  risk: {
    maxPositionFraction: number;
    stopLossFraction: number | null;
    takeProfitFraction: number | null;
    signalThreshold: number;
  };
  strategies: StrategySnapshotDTO[];
}

export interface RunSummaryDTO {
  id: string;
  coinId: string;
  strategyIds: string[];
  granularity: string;
  days: number;
  startingCash: number;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  tradeCount: number;
  roundTrips: number;
  candlesUsed: number;
  startTime: number;
  endTime: number;
  sharpe: number | null;
  buyHoldReturnPct: number | null;
  warmupBars: number;
  barSeconds: number;
  createdAt: number;
}

interface TradeDTO {
  side: "buy" | "sell";
  time: number;
  price: number;
  qty: number;
  fee: number;
  pnl: number | null;
  equityAfter: number;
  reason: string;
}

export interface ReplayData {
  candles: ChartCandle[];
  replayStartIndex: number;
  replayEndIndex: number;
  barSeconds: number;
  warmupBars: number;
  replayStartTime: number;
  replayEndTime: number;
}

interface RunDetail {
  summary: RunSummaryDTO;
  equityCurve: EquityPoint[];
  trades: TradeDTO[];
  replay: ReplayData;
}

interface CoinDTO {
  id: string;
  symbol: string;
  name: string;
  color: string;
  thesis: string;
}

interface TickerDTO {
  priceUsd: number;
  change24hPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  updatedAt: number;
}

const RANGES = [
  { key: "7", label: "7D" },
  { key: "30", label: "30D" },
  { key: "90", label: "90D" },
  { key: "365", label: "1Y" },
] as const;

/** How much history the replay reaches back. Hourly data tops out at 90 days. */
const HISTORY = [
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
  { key: 180, label: "180d" },
  { key: 365, label: "365d" },
] as const;

/**
 * Playback speed is expressed in **market time per second**, not bars per
 * second. Bars/sec is meaningless across granularities: 8 bars/sec on hourly
 * data is only 8 *hours* of history per second, but 8 bars/sec on daily data is
 * 8 *days*. With bars/sec the 365d replay appeared to "finish instantly"
 * because daily candles cover 24x more market time each.
 */
const SPEEDS = [
  { key: 1, label: "1 day/s" },
  { key: 3, label: "3 days/s" },
  { key: 7, label: "1 week/s" },
  { key: 30, label: "1 month/s" },
] as const;

interface LiveState {
  time: number;
  close: number;
  equity: number;
  cash: number;
  qty: number;
  entryPrice: number;
  unrealised: number;
  realised: number;
  positionPct: number;
  closedTrips: number;
  wins: number;
  equityCurve: EquityPoint[];
  trades: TradeDTO[];
}

const EMPTY_LIVE: LiveState = {
  time: 0,
  close: 0,
  equity: 0,
  cash: 0,
  qty: 0,
  entryPrice: 0,
  unrealised: 0,
  realised: 0,
  positionPct: 0,
  closedTrips: 0,
  wins: 0,
  equityCurve: [],
  trades: [],
};

/**
 * Reconstruct the exact account state as of candle `index` by replaying the
 * engine's own trade log. Equity comes from the engine's equity curve, and cash
 * is derived from it so the numbers can never disagree with each other.
 */
function deriveLiveState(run: RunDetail, index: number): LiveState {
  const { candles, replayStartIndex } = run.replay;
  const bar = candles[index];
  if (!bar) return EMPTY_LIVE;

  const eqIndex = Math.max(0, index - replayStartIndex);
  const equity = run.equityCurve[eqIndex]?.equity ?? run.summary.startingCash;
  const curve = run.equityCurve.slice(0, eqIndex + 1);

  const trades = run.trades.filter((t) => t.time <= bar.time);
  let qty = 0;
  let entryPrice = 0;
  let realised = 0;
  let closedTrips = 0;
  let wins = 0;

  for (const t of trades) {
    if (t.side === "buy") {
      qty = t.qty;
      entryPrice = t.price;
    } else {
      realised += t.pnl ?? 0;
      closedTrips += 1;
      if ((t.pnl ?? 0) > 0) wins += 1;
      qty = 0;
      entryPrice = 0;
    }
  }

  const unrealised = qty > 0 ? (bar.close - entryPrice) * qty : 0;
  const positionValue = qty * bar.close;

  return {
    time: bar.time,
    close: bar.close,
    equity,
    cash: equity - positionValue,
    qty,
    entryPrice,
    unrealised,
    realised,
    positionPct: equity > 0 ? (positionValue / equity) * 100 : 0,
    closedTrips,
    wins,
    equityCurve: curve,
    trades,
  };
}

export function CoinWorkspace({
  coin,
  bot,
  initialRuns,
  ticker,
}: {
  coin: CoinDTO;
  bot: BotSnapshotDTO;
  initialRuns: RunSummaryDTO[];
  ticker: TickerDTO | null;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("90");
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);

  const [selectedStrategyId, setSelectedStrategyId] = useState<string>(
    bot.strategies.find((s) => s.primary)?.strategyId ?? bot.strategies[0]?.strategyId ?? "",
  );
  const [historyDays, setHistoryDays] = useState<number>(90);
  const [configOpen, setConfigOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [runs, setRuns] = useState<RunSummaryDTO[]>(initialRuns);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  // ── Replay state ──────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(7);
  const [follow, setFollow] = useState(true);

  const loadCandles = useCallback(async () => {
    setChartLoading(true);
    setChartError(null);
    try {
      const res = await fetch(`/api/coins/${coin.id}/candles?days=${range}&source=ohlc`);
      const body = (await res.json()) as { candles?: ChartCandle[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to load candles");
      setCandles(body.candles ?? []);
    } catch (err) {
      setChartError((err as Error).message);
      setCandles([]);
    } finally {
      setChartLoading(false);
    }
  }, [coin.id, range]);

  useEffect(() => {
    void loadCandles();
  }, [loadCandles]);

  const lastIndex = run ? run.replay.replayEndIndex : 0;
  const atEnd = !run || cursor >= lastIndex;

  // Playback tick. Advances a consistent slice of *market time* each tick,
  // converting to however many bars that covers at the current bar size.
  const TICK_MS = 200;
  useEffect(() => {
    if (!playing || !run) return;
    const barSeconds = run.replay.barSeconds || 3600;
    let accumulated = 0;

    const id = setInterval(() => {
      accumulated += (speed * 86_400 * TICK_MS) / 1000 / barSeconds;
      const step = Math.floor(accumulated);
      if (step < 1) return;
      accumulated -= step;
      setCursor((c) => {
        const next = Math.min(lastIndex, c + step);
        if (next >= lastIndex) setPlaying(false);
        return next;
      });
    }, TICK_MS);

    return () => clearInterval(id);
  }, [playing, run, speed, lastIndex]);

  function resetReplay(r: ReplayData) {
    setCursor(r.replayStartIndex);
    setPlaying(false);
  }

  async function startTrade(config: TradeConfig) {
    if (!config.strategyId) {
      setRunError("Select a strategy.");
      return;
    }
    setHistoryDays(config.historyDays);
    setSelectedStrategyId(config.strategyId);
    setConfigOpen(false);
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/coins/${coin.id}/paper-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategyId: config.strategyId,
          historyDays: config.historyDays,
          source: "market-chart",
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        summary?: RunSummaryDTO;
        replay?: ReplayData;
        equityCurve?: EquityPoint[];
        trades?: TradeDTO[];
      };
      if (!res.ok || !body.summary || !body.replay) throw new Error(body.error ?? "Paper run failed");
      setRun({
        summary: body.summary,
        equityCurve: body.equityCurve ?? [],
        trades: body.trades ?? [],
        replay: body.replay,
      });
      resetReplay(body.replay);

      const listRes = await fetch(`/api/coins/${coin.id}/runs`);
      const listBody = (await listRes.json()) as { runs?: RunSummaryDTO[] };
      setRuns(listBody.runs ?? []);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function loadRun(runId: string) {
    if (loadingRunId) return;
    setLoadingRunId(runId);
    setRunError(null);
    try {
      const res = await fetch(`/api/runs/${runId}`);
      const body = (await res.json()) as Omit<RunDetail, "replay"> & {
        summary: RunSummaryDTO;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Failed to load run");

      // Stored runs don't persist candles; refetch the same window.
      const days = body.summary.days > 0 ? body.summary.days : 90;
      const barSec = body.summary.barSeconds ?? 3600;
      const warmupBars = body.summary.warmupBars ?? 0;
      // Re-fetch the same window the run used, including its warm-up budget.
      const warmDays = Math.ceil((warmupBars * barSec) / 86_400) + 2;
      const fetchDays = Math.min(730, days + warmDays);
      const candleRes = await fetch(`/api/coins/${coin.id}/candles?days=${fetchDays}&source=market-chart`);
      const candleBody = (await candleRes.json()) as { candles?: ChartCandle[]; granularity?: string };
      const cs = candleBody.candles ?? [];
      const replayBars = body.equityCurve.length;
      // A stored run ended at the most recent complete bar, so the freshest
      // candle is its last one and the replay occupies the final `replayBars`.
      const endIndex = cs.length - 1;
      const startIndex = Math.max(0, endIndex - replayBars + 1);

      const replay: ReplayData = {
        candles: cs,
        replayStartIndex: startIndex,
        replayEndIndex: endIndex,
        barSeconds: GRANULARITY_SECONDS[(candleBody.granularity ?? "1h") as Granularity] ?? barSec,
        warmupBars,
        replayStartTime: cs[startIndex]?.time ?? body.summary.startTime,
        replayEndTime: cs[endIndex]?.time ?? body.summary.endTime,
      };

      setRun({
        summary: body.summary,
        equityCurve: body.equityCurve,
        trades: body.trades,
        replay,
      });
      resetReplay(replay);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setLoadingRunId(null);
    }
  }

  const live = useMemo(() => (run ? deriveLiveState(run, cursor) : EMPTY_LIVE), [run, cursor]);

  const primaryIds = useMemo(
    () => bot.strategies.filter((s) => s.primary).map((s) => s.strategyId),
    [bot.strategies],
  );
  const selectedStrategy = useMemo(
    () => bot.strategies.find((s) => s.strategyId === selectedStrategyId) ?? null,
    [bot.strategies, selectedStrategyId],
  );

  // ── Chart data: replay takes over when active, otherwise the range view ────
  const chartCandles = useMemo<ChartCandle[]>(() => {
    if (!run) return candles;
    return run.replay.candles.slice(run.replay.replayStartIndex, cursor + 1);
  }, [run, cursor, candles]);

  const overlays = useMemo<ChartOverlay[]>(() => {
    if (chartCandles.length < 20) return [];
    const closes = chartCandles.map((c) => c.close);
    return [
      { label: "SMA 20", color: "#4f9cf9", values: sma(closes, 20) },
      { label: "SMA 50", color: "#d29922", values: sma(closes, 50) },
    ];
  }, [chartCandles]);

  const markers = useMemo<ChartMarker[]>(
    () => (run ? live.trades.map((t) => ({ time: t.time, side: t.side })) : []),
    [run, live.trades],
  );

  const s = run?.summary;
  const progress = run ? ((cursor - run.replay.replayStartIndex) / Math.max(1, lastIndex - run.replay.replayStartIndex)) * 100 : 0;
  const inPosition = live.qty > 0;

  // Market-time readouts so the two granularities are comparable at a glance.
  const daysPerBar = run ? (run.replay.barSeconds || 3600) / 86_400 : 0;
  const barsShown = run ? Math.max(0, cursor - run.replay.replayStartIndex + 1) : 0;
  const totalBars = run ? Math.max(1, lastIndex - run.replay.replayStartIndex + 1) : 1;
  const daysWatched = barsShown * daysPerBar;
  const totalDays = totalBars * daysPerBar;
  const etaSeconds = run && speed > 0 ? ((lastIndex - cursor) * daysPerBar) / speed : 0;

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
        <div className="coin-avatar" style={{ background: coin.color, width: 48, height: 48, fontSize: 14 }}>
          {coin.symbol.slice(0, 3)}
        </div>
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {coin.name} <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>{coin.symbol}</span>
          </h1>
          <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
            {bot.botName} · {bot.strategies.length} strategies · threshold ±
            {(bot.risk.signalThreshold * 100).toFixed(0)}%
          </div>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <div style={{ textAlign: "right" }}>
          <div className="coin-price mono">{formatUsd(ticker?.priceUsd ?? bot.lastClose)}</div>
          <div className={`mono ${changeClass(ticker?.change24hPct)}`} style={{ fontSize: 12.5, fontWeight: 600 }}>
            {formatPct(ticker?.change24hPct ?? null)} · 24h
          </div>
        </div>
      </div>

      <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: -6, marginBottom: 20, fontStyle: "italic" }}>
        {coin.thesis}
      </p>

      {/* ── Chart ──────────────────────────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>{run ? "Replay · " : "Market · "}{coin.symbol}/USD</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {run && (
              <span className="chip" style={{ color: inPosition ? "var(--green)" : "var(--text-faint)" }}>
                {inPosition ? `● LONG ${live.qty.toFixed(6)} @ ${formatUsd(live.entryPrice, { decimals: 2 })}` : "○ FLAT"}
              </span>
            )}
            {!run &&
              RANGES.map((r) => (
                <div key={r.key} className="seg">
                  <button className={range === r.key ? "active" : ""} onClick={() => setRange(r.key)}>
                    {r.label}
                  </button>
                </div>
              ))}
          </div>
        </div>

        {chartError && !run && <div className="notice notice-error" style={{ marginBottom: 12 }}>{chartError}</div>}
        {chartLoading && !run && candles.length === 0 ? (
          <div className="chart-shell" style={{ display: "grid", placeItems: "center", color: "var(--text-faint)" }}>
            <span className="mono" style={{ fontSize: 12 }}>Loading candles from CoinGecko…</span>
          </div>
        ) : (
          <CandleChart
            candles={chartCandles}
            overlays={overlays}
            markers={markers}
            follow={Boolean(run) && follow}
            visibleBars={110}
          />
        )}
        <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 11, color: "var(--text-faint)", flexWrap: "wrap" }}>
          <span><span style={{ color: "#4f9cf9" }}>━</span> SMA 20</span>
          <span><span style={{ color: "#d29922" }}>━</span> SMA 50</span>
          {run && <span>▲ buy · ▼ sell (live)</span>}
          <span className="spacer" style={{ flex: 1 }} />
          <span className="mono">
            {chartCandles.length} bars{run ? ` · ${s?.granularity}` : ` · ${range}d window`}
          </span>
        </div>
      </div>

      {/* ── Replay controls ────────────────────────────────────────────── */}
      {run && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-sm" onClick={() => resetReplay(run.replay)} title="Back to start">
                ⏮
              </button>
              <button
                className="btn btn-primary btn-sm"
                style={{ minWidth: 92 }}
                onClick={() => {
                  if (atEnd) resetReplay(run.replay);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? "⏸ Pause" : atEnd ? "▶ Replay" : "▶ Play"}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setCursor((c) => Math.min(lastIndex, c + 1))}
                disabled={atEnd}
                title="Step one bar"
              >
                ⏭
              </button>
              <button className="btn btn-sm" onClick={() => { setPlaying(false); setCursor(lastIndex); }} title="Skip to end">
                ⏭⏭
              </button>
            </div>

            <div className="seg">
              {SPEEDS.map((sp) => (
                <button key={sp.key} className={speed === sp.key ? "active" : ""} onClick={() => setSpeed(sp.key)}>
                  {sp.label}
                </button>
              ))}
            </div>

            <div className="spacer" style={{ flex: 1 }} />
            <button
              className={`btn btn-sm ${follow ? "" : "btn-ghost"}`}
              onClick={() => setFollow((f) => !f)}
              title="Keep the newest bar pinned to the right edge at a steady zoom"
            >
              {follow ? "🔗 Following" : "🔗 Follow"}
            </button>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
              {formatDateTime(live.time)} · bar {barsShown}/{totalBars}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setRun(null)}>
              Close replay
            </button>
          </div>

          <input
            type="range"
            min={run.replay.replayStartIndex}
            max={lastIndex}
            value={cursor}
            onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }}
            style={{ width: "100%" }}
          />
          <div
            className="mono"
            style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 4, display: "flex", gap: 14, flexWrap: "wrap" }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              watching <strong>{daysWatched.toFixed(0)}</strong> of {totalDays.toFixed(0)} days
            </span>
            <span>
              {barsShown} of {totalBars} {s?.granularity} bars
            </span>
            <span>~{etaSeconds < 1 ? "0" : etaSeconds.toFixed(0)}s left at {speed} day/s</span>
            <span>{progress.toFixed(0)}%</span>
            <span>
              window {formatDateTime(run.replay.replayStartTime)} → {formatDateTime(run.replay.replayEndTime)}
            </span>
            <span>historical only — the live bar is excluded</span>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "8px 0 0" }}>
            Speed is measured in <strong>market days per second</strong>, so it means the same thing on every
            history depth. A daily bar covers 24× more history than an hourly one, which is why the 365d replay has far
            fewer bars and runs quicker at the same setting.
          </p>
        </div>
      )}

      {/* ── Live account + strategies ──────────────────────────────────── */}
      <div className="panel-grid split" style={{ marginBottom: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h3>Paper Trading · Historical Replay</h3>
          </div>

          <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: -4 }}>
            Replays this bot&apos;s blend over real CoinGecko history, then plays it forward bar by bar. Nothing here
            touches live market data.
          </p>

          {/* Run configuration summary — the detail lives in the pane */}
          <div
            style={{
              border: "1px solid var(--border-soft)",
              borderRadius: 10,
              padding: 14,
              marginBottom: 14,
              background: "var(--bg-elev)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="section-title" style={{ margin: 0 }}>Next run</span>
              <span className="chip">{historyDays}d history</span>
              <span className="chip">{historyDays > 90 ? "daily" : "hourly"}</span>
              <span className="chip" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>
                {selectedStrategy ? selectedStrategy.name : "no strategy"}
              </span>
              <div className="spacer" style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={() => setConfigOpen(true)} disabled={running}>
                ⚙ Configure
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setConfigOpen(true)} disabled={running}>
                {running ? <span className="spin" /> : null}
                {running ? "Preparing…" : "Start paper trade"}
              </button>
            </div>
            <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "10px 0 0" }}>
              One strategy per session, so every trade is unambiguously that strategy&apos;s doing.{" "}
              {bot.strategies.length} strateg{bot.strategies.length === 1 ? "y" : "ies"} available for {coin.symbol}.
            </p>
          </div>

          {runError && <div className="notice notice-error" style={{ marginBottom: 12 }}>{runError}</div>}

          {!run && !running && (
            <div className="notice">
              Press <strong>Start paper trade</strong> to build a replay, then hit play to watch the bot work through
              the history. Pick a history depth above — 90d and below replays hourly bars.
            </div>
          )}

          {running && <div className="notice">Building the replay from cached CoinGecko history…</div>}

          {/* Live account state */}
          {run && !running && (
            <>
              <div className="section-title">Account · live at this bar</div>
              <div className="metrics" style={{ marginBottom: 16 }}>
                <div className="metric">
                  <div className="metric-label">Equity</div>
                  <div className={`metric-value mono ${changeClass(live.equity - s!.startingCash)}`}>
                    {formatUsd(live.equity, { compact: true })}
                  </div>
                  <div className="metric-hint">
                    {formatPct(((live.equity - s!.startingCash) / s!.startingCash) * 100)} from start
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">Cash</div>
                  <div className="metric-value mono">{formatUsd(live.cash, { compact: true })}</div>
                  <div className="metric-hint">{live.positionPct.toFixed(0)}% deployed</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Position</div>
                  <div className="metric-value mono" style={{ fontSize: 15, color: inPosition ? "var(--green)" : "var(--text-faint)" }}>
                    {inPosition ? "LONG" : "FLAT"}
                  </div>
                  <div className="metric-hint">
                    {inPosition ? `${live.qty.toFixed(6)} @ ${formatUsd(live.entryPrice, { decimals: 2 })}` : "no open position"}
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">Unrealised P&amp;L</div>
                  <div className={`metric-value mono ${changeClass(live.unrealised)}`}>
                    {formatUsd(live.unrealised, { decimals: 2 })}
                  </div>
                  <div className="metric-hint">open position</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Realised P&amp;L</div>
                  <div className={`metric-value mono ${changeClass(live.realised)}`}>
                    {formatUsd(live.realised, { decimals: 2 })}
                  </div>
                  <div className="metric-hint">
                    {live.closedTrips} closed · {live.closedTrips ? ((live.wins / live.closedTrips) * 100).toFixed(0) : "0"}% win
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">Price</div>
                  <div className="metric-value mono" style={{ fontSize: 16 }}>{formatUsd(live.close, { decimals: 2 })}</div>
                  <div className="metric-hint">{formatDateTime(live.time)}</div>
                </div>
              </div>

              {live.equityCurve.length > 1 && (
                <>
                  <div className="section-title">Equity Curve</div>
                  <EquityChart points={live.equityCurve} baseline={s!.startingCash} height={180} color={coin.color} />
                </>
              )}
            </>
          )}

          {/* End-of-run summary */}
          {s && !running && atEnd && (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Final result</div>
              <div className="metrics">
                <div className="metric">
                  <div className="metric-label">Total Return</div>
                  <div className={`metric-value mono ${changeClass(s.totalReturnPct)}`}>{formatPct(s.totalReturnPct)}</div>
                  <div className="metric-hint">buy &amp; hold {formatPct(s.buyHoldReturnPct ?? null)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Max Drawdown</div>
                  <div className="metric-value mono" style={{ color: "var(--red)" }}>-{s.maxDrawdownPct.toFixed(2)}%</div>
                  <div className="metric-hint">peak to trough</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Win Rate</div>
                  <div className="metric-value mono">{s.winRatePct.toFixed(1)}%</div>
                  <div className="metric-hint">{s.roundTrips} round trips</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Sharpe</div>
                  <div className="metric-value mono">{s.sharpe === null ? "—" : s.sharpe.toFixed(2)}</div>
                  <div className="metric-hint">annualised</div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Strategy panel */}
        <div className="panel">
          <div className="panel-head">
            <h3>Strategies</h3>
            <span className="locked-note" title="Strategies are defined in code and cannot be edited, added or removed.">
              🔒 permanent · read-only
            </span>
          </div>
          <div className="metrics" style={{ marginBottom: 12 }}>
            <div className="metric">
              <div className="metric-label">{selectedStrategy ? `${selectedStrategy.name} now` : "Current signal"}</div>
              <div
                className="metric-value"
                style={{
                  fontSize: 15,
                  color:
                    selectedStrategy?.signal.action === "buy"
                      ? "var(--green)"
                      : selectedStrategy?.signal.action === "sell"
                        ? "var(--red)"
                        : "var(--text-dim)",
                }}
              >
                {selectedStrategy ? selectedStrategy.signal.action.toUpperCase() : "—"}
                {selectedStrategy && selectedStrategy.signal.action !== "hold"
                  ? ` ${(selectedStrategy.signal.strength * 100).toFixed(0)}%`
                  : ""}
              </div>
              <div className="metric-hint">next-bar signal</div>
            </div>
            <div className="metric">
              <div className="metric-label">Stop Loss</div>
              <div className="metric-value">
                {bot.risk.stopLossFraction !== null ? `${(bot.risk.stopLossFraction * 100).toFixed(0)}%` : "none"}
              </div>
              <div className="metric-hint">hard exit below entry</div>
            </div>
          </div>
          {bot.strategies.map((st) => {
            const isSelected = st.strategyId === selectedStrategyId;
            return (
              <div
                key={st.strategyId}
                className="strategy-item"
                style={isSelected ? undefined : { opacity: 0.5 }}
              >
                <div className="strategy-item-head">
                  <span style={{ color: isSelected ? "var(--accent)" : "var(--text-faint)" }}>
                    {isSelected ? "●" : "○"}
                  </span>
                  <span className="strategy-name">{st.name}</span>
                <span
                  className={`chip ${
                    st.signal.action === "buy" ? "chip-buy" : st.signal.action === "sell" ? "chip-sell" : "chip-hold"
                  }`}
                >
                  {st.signal.action.toUpperCase()}
                  {st.signal.action !== "hold" ? ` ${(st.signal.strength * 100).toFixed(0)}%` : ""}
                </span>
                <div className="spacer" style={{ flex: 1 }} />
                <span className="chip">{st.category}</span>
                <span className="chip">weight {st.weight.toFixed(2)}</span>
              </div>
              <div className="strategy-desc">{st.description}</div>
              <div className="strategy-params">
                {Object.entries(st.params).map(([k, v]) => (
                  <span key={k} className="param-pill">{k}={v}</span>
                ))}
              </div>
              <div className="signal-reason">{st.signal.reason}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Live trade log ─────────────────────────────────────────────── */}
      {run && !running && live.trades.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Trade Log ({live.trades.length} of {run.trades.length})</h3>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>up to this bar</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Side</th><th className="align-right">Price</th>
                  <th className="align-right">Qty</th><th className="align-right">Fee</th>
                  <th className="align-right">Realised P&amp;L</th><th>Trigger</th>
                </tr>
              </thead>
              <tbody>
                {[...live.trades].reverse().map((t, i) => (
                  <tr key={`${t.time}-${t.side}-${i}`}>
                    <td className="mono">{formatDateTime(t.time)}</td>
                    <td className={t.side === "buy" ? "up" : "down"} style={{ fontWeight: 600 }}>{t.side.toUpperCase()}</td>
                    <td className="align-right mono">{formatUsd(t.price, { decimals: 4 })}</td>
                    <td className="align-right mono">{t.qty.toFixed(6)}</td>
                    <td className="align-right mono">{formatUsd(t.fee, { decimals: 2 })}</td>
                    <td className={`align-right mono ${t.pnl === null ? "flat" : changeClass(t.pnl)}`}>
                      {t.pnl === null ? "—" : formatUsd(t.pnl, { decimals: 2 })}
                    </td>
                    <td style={{ maxWidth: 420, whiteSpace: "normal", color: "var(--text-dim)", fontSize: 11.5 }}>{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TradeConfigModal
        open={configOpen}
        coinSymbol={coin.symbol}
        strategies={bot.strategies}
        initial={{ historyDays, strategyId: selectedStrategyId }}
        busy={running}
        onCancel={() => setConfigOpen(false)}
        onStart={(config) => void startTrade(config)}
      />

      {/* ── Run history ────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel-head">
          <h3>Paper Run History</h3>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{runs.length} runs stored</span>
        </div>
        {runs.length === 0 ? (
          <div className="notice">No paper runs recorded yet for {coin.symbol}.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Window</th><th>Strategies</th>
                  <th className="align-right">Return</th><th className="align-right">Buy &amp; Hold</th>
                  <th className="align-right">Max DD</th><th className="align-right">Win %</th>
                  <th className="align-right">Trips</th><th className="align-right">Sharpe</th><th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{timeAgo(r.createdAt)}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.days}d · {r.granularity}</td>
                    <td style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                      {r.strategyIds.map((id) => bot.strategies.find((s) => s.strategyId === id)?.name ?? id).join(", ")}
                    </td>
                    <td className={`align-right mono ${changeClass(r.totalReturnPct)}`}>{formatPct(r.totalReturnPct)}</td>
                    <td className={`align-right mono ${changeClass(r.buyHoldReturnPct)}`}>{formatPct(r.buyHoldReturnPct)}</td>
                    <td className="align-right mono down">-{r.maxDrawdownPct.toFixed(1)}%</td>
                    <td className="align-right mono">{r.winRatePct.toFixed(0)}%</td>
                    <td className="align-right mono">{r.roundTrips}</td>
                    <td className="align-right mono">{r.sharpe === null ? "—" : r.sharpe.toFixed(2)}</td>
                    <td className="align-right">
                      <button className="btn btn-ghost btn-sm" onClick={() => void loadRun(r.id)} disabled={loadingRunId === r.id}>
                        {loadingRunId === r.id ? "…" : "Replay"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
