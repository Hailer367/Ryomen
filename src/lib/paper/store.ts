import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { EquityPoint, PaperRunResult, PaperTrade, SignalLogEntry } from "@/lib/paper/types";

export interface PaperRunRow {
  id: string;
  coin_id: string;
  strategy_ids: string;
  granularity: string;
  days: number;
  starting_cash: number;
  final_equity: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  win_rate_pct: number;
  trade_count: number;
  round_trips: number;
  candles_used: number;
  start_time: number;
  end_time: number;
  sharpe: number | null;
  buy_hold_return_pct: number | null;
  signal_log: string | null;
  warmup_bars: number;
  bar_seconds: number;
  status: string;
  error: string | null;
  created_at: number;
}

export interface PaperRunSummary {
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
  /** Bars consumed by indicator warm-up, needed to reopen this run's replay. */
  warmupBars: number;
  /** Seconds per bar at the time of the run. */
  barSeconds: number;
  status: string;
  error: string | null;
  createdAt: number;
}

function toSummary(row: PaperRunRow): PaperRunSummary {
  return {
    id: row.id,
    coinId: row.coin_id,
    strategyIds: JSON.parse(row.strategy_ids) as string[],
    granularity: row.granularity,
    days: row.days,
    startingCash: row.starting_cash,
    finalEquity: row.final_equity,
    totalReturnPct: row.total_return_pct,
    maxDrawdownPct: row.max_drawdown_pct,
    winRatePct: row.win_rate_pct,
    tradeCount: row.trade_count,
    roundTrips: row.round_trips,
    candlesUsed: row.candles_used,
    startTime: row.start_time,
    endTime: row.end_time,
    sharpe: row.sharpe,
    buyHoldReturnPct: row.buy_hold_return_pct,
    warmupBars: row.warmup_bars ?? 0,
    barSeconds: row.bar_seconds ?? 3600,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

/** Persist a completed paper run plus its trades, equity curve and signal log. */
export function savePaperRun(result: PaperRunResult): string {
  const db = getDb();
  const id = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

  const insertRun = db.prepare(
    `INSERT INTO paper_runs (
       id, coin_id, strategy_ids, granularity, days, starting_cash, final_equity,
       total_return_pct, max_drawdown_pct, win_rate_pct, trade_count, round_trips,
       candles_used, start_time, end_time, sharpe, buy_hold_return_pct, signal_log,
       warmup_bars, bar_seconds, status, created_at
     ) VALUES (
       @id, @coin_id, @strategy_ids, @granularity, @days, @starting_cash, @final_equity,
       @total_return_pct, @max_drawdown_pct, @win_rate_pct, @trade_count, @round_trips,
       @candles_used, @start_time, @end_time, @sharpe, @buy_hold_return_pct, @signal_log,
       @warmup_bars, @bar_seconds, 'completed', @created_at
     )`,
  );

  const insertTrade = db.prepare(
    `INSERT INTO paper_trades (run_id, coin_id, side, time, price, qty, fee, pnl, equity_after, reason)
     VALUES (@run_id, @coin_id, @side, @time, @price, @qty, @fee, @pnl, @equity_after, @reason)`,
  );

  const insertEquity = db.prepare(
    `INSERT INTO paper_equity (run_id, time, equity) VALUES (?, ?, ?)`,
  );

  const signalLog: SignalLogEntry[] = result.signalLog.slice(-400);

  const tx = db.transaction(() => {
    insertRun.run({
      id,
      coin_id: result.coinId,
      strategy_ids: JSON.stringify(result.strategyIds),
      granularity: result.granularity,
      days: typeof result.days === "number" ? result.days : -1,
      starting_cash: result.startingCash,
      final_equity: result.finalEquity,
      total_return_pct: result.totalReturnPct,
      max_drawdown_pct: result.maxDrawdownPct,
      win_rate_pct: result.winRatePct,
      trade_count: result.tradeCount,
      round_trips: result.roundTrips,
      candles_used: result.candlesUsed,
      start_time: result.startTime,
      end_time: result.endTime,
      sharpe: result.sharpe,
      buy_hold_return_pct: result.buyHoldReturnPct,
      signal_log: JSON.stringify(signalLog),
      warmup_bars: result.warmupBars,
      bar_seconds: result.barSeconds,
      created_at: Date.now(),
    });

    for (const t of result.trades) {
      insertTrade.run({
        run_id: id,
        coin_id: result.coinId,
        side: t.side,
        time: t.time,
        price: t.price,
        qty: t.qty,
        fee: t.fee,
        pnl: t.pnl,
        equity_after: t.equityAfter,
        reason: t.reason,
      });
    }

    for (const p of result.equityCurve) {
      insertEquity.run(id, p.time, p.equity);
    }
  });

  tx();
  return id;
}

export function listRuns(coinId?: string, limit = 50): PaperRunSummary[] {
  const db = getDb();
  const rows = (
    coinId
      ? db
          .prepare(`SELECT * FROM paper_runs WHERE coin_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(coinId, limit)
      : db.prepare(`SELECT * FROM paper_runs ORDER BY created_at DESC LIMIT ?`).all(limit)
  ) as PaperRunRow[];
  return rows.map(toSummary);
}

export function getRun(row: {
  id: string;
}): { summary: PaperRunSummary; trades: PaperTrade[]; equityCurve: EquityPoint[]; signalLog: SignalLogEntry[] } | null {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM paper_runs WHERE id = ?`).get(row.id) as PaperRunRow | undefined;
  if (!run) return null;

  const tradeRows = db
    .prepare(`SELECT * FROM paper_trades WHERE run_id = ? ORDER BY time ASC, id ASC`)
    .all(run.id) as {
    side: "buy" | "sell";
    time: number;
    price: number;
    qty: number;
    fee: number;
    pnl: number | null;
    equity_after: number;
    reason: string | null;
  }[];

  const equityRows = db
    .prepare(`SELECT time, equity FROM paper_equity WHERE run_id = ? ORDER BY time ASC`)
    .all(run.id) as EquityPoint[];

  return {
    summary: toSummary(run),
    trades: tradeRows.map((t) => ({
      side: t.side,
      time: t.time,
      price: t.price,
      qty: t.qty,
      fee: t.fee,
      pnl: t.pnl,
      equityAfter: t.equity_after,
      reason: t.reason ?? "",
    })),
    equityCurve: equityRows,
    signalLog: run.signal_log ? (JSON.parse(run.signal_log) as SignalLogEntry[]) : [],
  };
}

export function deleteRun(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM paper_runs WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function latestRunPerCoin(): Map<string, PaperRunSummary> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.* FROM paper_runs r
        JOIN (SELECT coin_id, MAX(created_at) AS mx FROM paper_runs GROUP BY coin_id) m
          ON m.coin_id = r.coin_id AND m.mx = r.created_at`,
    )
    .all() as PaperRunRow[];
  return new Map(rows.map((r) => [r.coin_id, toSummary(r)]));
}
