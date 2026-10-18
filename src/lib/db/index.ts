import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config } from "@/lib/config";

export type DB = Database.Database;

/**
 * Schema. Ryomen only ever writes *derived* state here — market data caches,
 * paper-trading runs and trade logs. Strategy definitions live in code and are
 * never persisted, so they cannot drift from what the engine actually runs.
 */
const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS candles (
  coin_id     TEXT    NOT NULL,
  granularity TEXT    NOT NULL,
  time        INTEGER NOT NULL,
  open        REAL    NOT NULL,
  high        REAL    NOT NULL,
  low         REAL    NOT NULL,
  close       REAL    NOT NULL,
  PRIMARY KEY (coin_id, granularity, time)
);

CREATE TABLE IF NOT EXISTS candle_cache_meta (
  coin_id     TEXT    NOT NULL,
  granularity TEXT    NOT NULL,
  source      TEXT    NOT NULL,
  fetched_at  INTEGER NOT NULL,
  covers_from INTEGER NOT NULL,
  covers_to   INTEGER NOT NULL,
  PRIMARY KEY (coin_id, granularity)
);

CREATE TABLE IF NOT EXISTS tickers (
  coin_id         TEXT    PRIMARY KEY,
  price_usd       REAL    NOT NULL,
  change_24h_pct  REAL,
  market_cap_usd  REAL,
  volume_24h_usd  REAL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_runs (
  id                TEXT    PRIMARY KEY,
  coin_id           TEXT    NOT NULL,
  strategy_ids      TEXT    NOT NULL,
  granularity       TEXT    NOT NULL,
  days              INTEGER NOT NULL,
  starting_cash     REAL    NOT NULL,
  final_equity      REAL    NOT NULL,
  total_return_pct  REAL    NOT NULL,
  max_drawdown_pct  REAL    NOT NULL,
  win_rate_pct      REAL    NOT NULL,
  trade_count       INTEGER NOT NULL,
  round_trips       INTEGER NOT NULL DEFAULT 0,
  candles_used      INTEGER NOT NULL DEFAULT 0,
  start_time        INTEGER NOT NULL DEFAULT 0,
  end_time          INTEGER NOT NULL DEFAULT 0,
  sharpe            REAL,
  buy_hold_return_pct REAL,
  signal_log        TEXT,
  status            TEXT    NOT NULL,
  error             TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_runs_coin ON paper_runs (coin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL REFERENCES paper_runs (id) ON DELETE CASCADE,
  coin_id      TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  time         INTEGER NOT NULL,
  price        REAL    NOT NULL,
  qty          REAL    NOT NULL,
  fee          REAL    NOT NULL,
  pnl          REAL,
  equity_after REAL    NOT NULL,
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_run ON paper_trades (run_id, time);

CREATE TABLE IF NOT EXISTS paper_equity (
  run_id TEXT    NOT NULL REFERENCES paper_runs (id) ON DELETE CASCADE,
  time   INTEGER NOT NULL,
  equity REAL    NOT NULL,
  PRIMARY KEY (run_id, time)
);

CREATE TABLE IF NOT EXISTS signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin_id    TEXT    NOT NULL,
  strategy_id TEXT   NOT NULL,
  time       INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  reason     TEXT,
  price      REAL    NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function resolveDbPath(): string {
  const p = config.db.path;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function createConnection(): DB {
  const dbPath = resolveDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Dev-safe schema guard. The candle cache used to be keyed by (coin, granularity,
 * days); it is now keyed by (coin, granularity) with an explicit time range,
 * because the request window is derived from the series rather than the other
 * way round. Older databases are dropped and refetched rather than migrated.
 */
function migrate(db: DB): void {
  const cols = db.pragma(`table_info(candle_cache_meta)`) as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "covers_from")) {
    db.exec(`DROP TABLE IF EXISTS candle_cache_meta; DROP TABLE IF EXISTS candles;`);
    db.exec(SCHEMA);
  }

  // Additive columns for paper_runs, so existing databases pick them up.
  const runCols = db.pragma(`table_info(paper_runs)`) as { name: string }[];
  if (runCols.length > 0) {
    const existing = new Set(runCols.map((c) => c.name));
    if (!existing.has("warmup_bars")) db.exec(`ALTER TABLE paper_runs ADD COLUMN warmup_bars INTEGER NOT NULL DEFAULT 0`);
    if (!existing.has("bar_seconds")) db.exec(`ALTER TABLE paper_runs ADD COLUMN bar_seconds INTEGER NOT NULL DEFAULT 3600`);
  }
}

// Reuse a single connection across hot reloads / route invocations.
const globalForDb = globalThis as unknown as { __ryomenDb?: DB };

export function getDb(): DB {
  if (!globalForDb.__ryomenDb) {
    globalForDb.__ryomenDb = createConnection();
  }
  return globalForDb.__ryomenDb;
}

export function closeDb(): void {
  if (globalForDb.__ryomenDb) {
    globalForDb.__ryomenDb.close();
    delete globalForDb.__ryomenDb;
  }
}
