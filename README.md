# Ryomen

**Ryomen** is a multi-coin automated crypto trading bot. It runs eight independent
bots — one per asset — each with its own permanently-assigned strategy blend,
its own dashboard, and its own paper-trading history.

Market data comes from the [CoinGecko](https://www.coingecko.com/en/api) API.
There is **no manual trading interface**: every action is produced by the
strategy engine, and strategies are defined in code and cannot be created,
edited, or deleted from the UI.

---

## Concepts

| Concept | Description |
| --- | --- |
| **Coin** | One of eight fixed assets. See `src/lib/coins.ts`. |
| **Strategy** | A permanent, deep-frozen rule set. See `src/lib/strategies/builtin.ts`. |
| **Bot** | A coin + a weighted blend of strategies + a risk envelope. See `src/lib/bot/config.ts`. |
| **Paper run** | A replay of one bot over *real historical CoinGecko data*, with fees and slippage. |
| **Live mode** | Deliberately stubbed. Execution is behind an interface; nothing places real orders. |

### The eight bots

| Coin | Bot | Strategy blend |
| --- | --- | --- |
| BTC | BTC Trend Sentinel | Golden Cross · MACD Trend Rider · Donchian Breakout |
| ETH | ETH Beta Engine | Golden Cross · MACD Trend Rider · ROC Momentum |
| SOL | SOL Breakout Hunter | Donchian Breakout · ROC Momentum · MACD Trend Rider |
| DOGE | DOGE Exhaustion Trader | RSI Exhaustion Reversal · Bollinger Reversion · ROC Momentum |
| BNB | BNB Steady Trend | Golden Cross · MACD Trend Rider · ROC Momentum |
| HYPE | HYPE Volatility Guard | Donchian Breakout · ROC Momentum |
| TRX | TRX Range Trader | Bollinger Reversion · RSI Exhaustion Reversal |
| ZEC | ZEC Momentum Cyclical | MACD Trend Rider · ROC Momentum · Golden Cross |

### The strategy library

Six strategies, all permanent:

- `sma-golden-cross` — **Moving-Average Crossover** (Trend) — *primary strategy*
- `donchian-breakout` — **Donchian Breakout** (Breakout)
- `macd-trend` — **MACD Trend Rider** (Momentum)
- `roc-momentum` — **ROC Momentum** (Momentum)
- `bollinger-reversion` — **Bollinger Reversion** (Mean Reversion)
- `rsi-reversal` — **RSI Exhaustion Reversal** (Mean Reversion)

Each strategy receives a `StrategyContext` (candles, current index, open
position, params) and returns a `StrategySignal`.

### One strategy per session

A paper session runs **exactly one strategy**. You pick it in the configuration
pane; the API rejects anything else with HTTP 400.

Blending several strategies into one weighted vote makes attribution impossible
— you can never tell which one caused a trade, and as the library grows that
becomes the main thing you want to know. One strategy per session means every
fill is unambiguously that strategy's doing, and each trade log names it:

```
Moving-Average Crossover: SMA(20) crossed above SMA(50) — buying.
Moving-Average Crossover: stop-loss hit at 2692.93.
```

Strategies also declare **per-bar-size calibrations**. The same rule behaves
very differently at different resolutions, so the engine picks tuned periods:

| Granularity | Crossover periods |
| --- | --- |
| 1h | SMA 50/200 (≈2d vs ≈8d) |
| 4h | SMA 30/120 (≈5d vs ≈20d) |
| 1d | SMA 20/50 (20d vs 50d) |

Adding a strategy is a code change in `src/lib/strategies/builtin.ts` plus one
assignment in `src/lib/bot/config.ts`; it then appears automatically in the
configuration pane.

---

## Getting started

```bash
npm install
cp .env.example .env.local     # optional; sane defaults are baked in
npm run db:init                # create the SQLite schema
npm run dev                    # http://localhost:3000
```

### Populate data

Run this once after starting — it pre-fetches every coin's history and the
ticker snapshot, so browsing afterwards makes no external calls:

```bash
npm run warm -- --full
```

CoinGecko's free tier only allows a handful of requests per minute, so the warm
takes one to two minutes. Progress is printed per coin; it's safe to re-run.

You can also trigger runs from the UI (**Run paper trade** on any coin page, or
**Run all bots** on the overview), or from the CLI:

```bash
npm run backtest -- bitcoin          # one bot
npm run backtest -- solana 90        # one bot, 90-day window
npm run backtest:all                 # the whole fleet, sequentially
```

---

## Paper trading

A paper run replays a bot's strategy blend over real historical data:

- decisions are made on **closed candles only** (no look-ahead),
- protective stops are checked **intrabar** against each bar's high/low,
- every fill pays **fees and slippage**,
- the position is **long-only** (spot), matching the live bot's posture,
- results include an equity curve, executed orders, max drawdown, win rate and
  annualised Sharpe — alongside a buy-and-hold benchmark.

Data sources:

| Source | Endpoint | Granularity | Used for |
| --- | --- | --- | --- |
| `ohlc` | `/coins/{id}/ohlc` | 30m / 4h / 1d | dashboard candles (true OHLC) |
| `market-chart` | `/coins/{id}/market_chart` | 5m / 1h / 1d | paper runs (far more bars) |

Both are cached in SQLite; `RYOMEN_CACHE_TTL_SECONDS` controls freshness.

---

## CoinGecko API efficiency

The free tier is genuinely tight. Measured directly against the public API:
**three rapid requests succeed, the fourth returns HTTP 429**, with no
`Retry-After` header. There is no way around that — so Ryomen optimises for
*fewer* requests rather than faster ones.

### The budget

A token bucket (`src/lib/coingecko/limiter.ts`) allows `COINGECKO_BURST`
requests back-to-back, then refills at `COINGECKO_REQUESTS_PER_MINUTE`
(default 5 — deliberately below the observed limit). Requests are served FIFO
through a serial chain, so a slow call can never reorder or starve others.

When a 429 does arrive, it trips a **global circuit breaker**: every caller
backs off with exponential backoff, not just the request that tripped it.
Without this, N queued requests each discover the limit independently and burn
N round trips finding out.

### The six optimisations

1. **Stale-while-revalidate.** If any usable copy exists, callers get an
   immediate answer and the refresh happens in the background. A cache miss
   never blocks on the network.
2. **Request coalescing.** Concurrent callers asking for the same URL share a
   single in-flight promise — loading a coin page and firing a paper trade at
   the same moment costs one call, not two.
3. **One series per coin.** `/market_chart` is richer than `/ohlc` on the free
   tier (hourly for 90 days, vs 4-hourly). All chart ranges and backtests are
   derived from that one cached series by resampling (`src/lib/market/series.ts`).
   A 7-day chart, a 90-day chart and a backtest all cost the same single call.
4. **Conditional requests.** CoinGecko sends ETags; we store and replay them so
   a poll that changed nothing returns `304` instead of a body.
5. **Coverage tracking.** The cache records the real time range it covers, so a
   30-day request can be answered from a 90-day fetch instead of triggering a
   second one.
6. **Warm-once.** `npm run warm` pre-fetches everything.

### Measured result

Against a fully warm cache:

| Action | External requests |
| --- | --- |
| `npm run warm -- --full` | 17 (one time) |
| 10 page loads | 0 |
| 32 chart range requests (8 coins × 4 ranges) | 0 |
| 8 backtest data loads | 0 |
| A paper trade replay | 0 |

`GET /api/health` exposes live counters (`network`, `cacheHits`, `notModified`,
`rateLimited`, `bytes`) so you can verify this yourself.

---

## Configuration

```
src/
  app/                     Next.js App Router
    page.tsx               fleet overview
    coins/[id]/page.tsx    per-coin dashboard
    strategies/page.tsx    read-only strategy catalogue
    api/                   route handlers (JSON)
  components/              UI (charts, workspace, tables)
  lib/
    coins.ts               the eight assets
    config.ts              env-driven configuration
    coingecko/client.ts    throttled, retrying API client
    market/service.ts      cache-aware data access
    indicators/            SMA, EMA, RSI, MACD, ATR, Bollinger, Donchian
    strategies/            strategy types + permanent built-ins + registry
    bot/                   bot definitions, signal aggregation, snapshots
    paper/                 replay engine, metrics, persistence
    db/                    SQLite connection + schema
scripts/                   CLI: init-db, backtest, backtest-all
```

### Data flow

```
CoinGecko ──► client (throttle/retry) ──► market service ──► SQLite cache
                                              │
                                              ▼
                          bot snapshot ──► strategies.evaluate(ctx)
                                              │
                                              ▼
                            aggregateVotes() ──► paper engine ──► SQLite
```

---

## Configuration

All configuration lives in `.env.local` (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `COINGECKO_BASE_URL` | public API | API base |
| `COINGECKO_API_KEY` | – | Demo/Pro key (adds `x-cg-demo-api-key`) |
| `COINGECKO_REQUESTS_PER_MINUTE` | `5` | Token-bucket refill rate |
| `COINGECKO_BURST` | `2` | Requests allowed back-to-back |
| `RYOMEN_DB_PATH` | `data/ryomen.db` | SQLite location |
| `RYOMEN_CACHE_TTL_SECONDS` | `300` | When cached data counts as fresh |
| `RYOMEN_STALE_TTL_SECONDS` | `3600` | How long stale data may be served while refreshing |
| `RYOMEN_STARTING_CASH` | `10000` | Default paper account size |
| `RYOMEN_FEE_BPS` | `10` | Fee per fill (basis points) |
| `RYOMEN_SLIPPAGE_BPS` | `5` | Slippage per fill (basis points) |

## Architecture

---

## Extending

Strategies are code, so adding one is a code change — deliberately:

1. Implement a `Strategy` in `src/lib/strategies/builtin.ts`.
2. Register it in `STRATEGIES` (`src/lib/strategies/index.ts`).
3. Assign it to one or more bots in `src/lib/bot/config.ts`.

The registry validates at import time: unknown coins or strategies throw
immediately, so a bad edit fails fast rather than silently.

> ⚠️ **Not financial advice.** Paper results are simulations over historical
> data. Past performance does not predict future returns.
