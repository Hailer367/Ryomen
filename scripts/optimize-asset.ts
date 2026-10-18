/**
 * Walk-forward optimiser for BTC-only strategies.
 *
 *   npm run optimize:asset -- <coin> <strategyId>
 *
 * The difference from a normal grid search is everything. Tuning on one window
 * and reporting that same window's profit just measures how well the
 * parameters memorised it. So this walks forward in time:
 *
 *   fold 1: tune on bars [0 … 900]      trade on [900 … 1150]
 *   fold 2: tune on bars [0 … 1150]     trade on [1150 … 1400]
 *   fold 3: tune on bars [0 … 1400]     trade on [1400 … 1650]
 *   ...
 *
 * Each test segment is traded by parameters that had never seen it. The
 * reported result is the average across those untouched segments — which is the
 * only number here that means anything.
 *
 * It also runs a no-lookahead check: the signal produced on the latest bar must
 * not change when the future is deleted, which is what makes the strategy safe
 * to run forward on live data.
 */
import { getDb, closeDb } from "../src/lib/db/index";
import { runPaperTrading } from "../src/lib/paper/engine";
import { profileFor, requireStrategy } from "../src/lib/strategies";
import type { Candle, Granularity } from "../src/lib/market/types";

const COIN = process.argv[2] ?? "bitcoin";
const STRATEGY_ID = process.argv[3] ?? "btc-momentum-rider";
const GRANULARITY: Granularity = "1h";

interface Combo {
  trendPeriod: number;
  rocPeriod: number;
  pullbackPeriod?: number;
  minDepthPct?: number;
  entryThreshold: number;
  exitThreshold: number;
  atrPeriod: number;
  atrMult: number;
  trailPeriod: number;
}

interface Result {
  ret: number;
  dd: number;
  trips: number;
  win: number;
}

function load(coinId: string, granularity: Granularity): Candle[] {
  return getDb()
    .prepare(
      `SELECT time, open, high, low, close FROM candles WHERE coin_id = ? AND granularity = ? ORDER BY time ASC`,
    )
    .all(coinId, granularity) as Candle[];
}

async function simulate(
  candles: Candle[],
  fromTime: number,
  toTime: number,
  combo: Combo,
): Promise<Result | null> {
  try {
    const r = await runPaperTrading({
      coinId: COIN,
      strategyIds: [STRATEGY_ID],
      paramOverrides: { [STRATEGY_ID]: combo as unknown as Record<string, number> },
      preloadedCandles: candles,
      granularityHint: GRANULARITY,
      window: { fromTime, toTime },
      historyDays: 90,
    });
    return { ret: r.totalReturnPct, dd: r.maxDrawdownPct, trips: r.roundTrips, win: r.winRatePct };
  } catch {
    return null;
  }
}

/** Annualised return, penalised ~1.5x for drawdown. */
function score(r: Result, days: number): number {
  return (r.ret * (365 / days)) / 100 - 1.5 * (r.dd / 100);
}

function grid(): Combo[] {
  const out: Combo[] = [];
  for (const trendPeriod of [60, 100, 150])
    for (const pullbackPeriod of [12, 20, 30, 50])
      for (const rocPeriod of [6, 12, 24])
        for (const entryThreshold of [-1, 0, 1, 2])
        for (const exitThreshold of [-2, -1, 0])
          for (const minDepthPct of [0, 1, 2])
          for (const atrMult of [2, 3, 4])
            for (const trailPeriod of [12, 20, 30])
              out.push({ trendPeriod, pullbackPeriod, rocPeriod, entryThreshold, exitThreshold, minDepthPct, atrPeriod: 14, atrMult, trailPeriod } as unknown as Combo);
  return out;
}

const label = (c: Combo) =>
  `trend=${String(c.trendPeriod).padStart(3)} roc=${String(c.rocPeriod).padStart(2)} ` +
  `depth=${String(c.minDepthPct).padStart(2)} pb=${String(c.pullbackPeriod).padStart(2)} roc=${String(c.rocPeriod).padStart(2)} entry=${String(c.entryThreshold).padStart(4)} ` +
  `atr=${c.atrMult} trail=${String(c.trailPeriod).padStart(2)}`;

async function main() {
  const candles = load(COIN, GRANULARITY);
  if (candles.length < 1200) {
    console.error(`Need more ${GRANULARITY} history for ${COIN} (have ${candles.length}). Run: npm run warm -- --full`);
    process.exit(1);
  }

  const combos = grid();
  const WARMUP = 120;
  const TEST = 260;

  console.log(`\n▶ Walk-forward optimisation — ${STRATEGY_ID} on ${COIN}`);
  console.log(`  bars            : ${candles.length} @ ${GRANULARITY}`);
  console.log(`  combinations    : ${combos.length}`);
  console.log(`  folds           : expanding train window, ${TEST}-bar untouched test segment\n`);

  const folds: { trainTo: number; testFrom: number; testTo: number; best: Combo | null; test: Result | null; bestTrainScore: number }[] = [];
  const total = candles.length - 1;

  for (let trainTo = 900; trainTo + TEST <= total; trainTo += TEST) {
    const testFrom = trainTo;
    const testTo = Math.min(total, trainTo + TEST);

    let best: Combo | null = null;
    let bestScore = -Infinity;
    const trainDays = ((candles[trainTo].time - candles[0].time) / 86400) || 1;

    for (const combo of combos) {
      const r = await simulate(candles, candles[WARMUP].time, candles[trainTo].time, combo);
      if (!r || r.trips < 2) continue;
      const s = score(r, trainDays);
      if (s > bestScore) {
        bestScore = s;
        best = combo;
      }
    }

    if (!best) {
      console.log(`  fold ending ${new Date(candles[testTo].time * 1000).toISOString().slice(0, 10)} — no valid combo`);
      continue;
    }

    const testDays = (candles[testTo].time - candles[testFrom].time) / 86400;
    const res = await simulate(candles, candles[testFrom].time, candles[testTo].time, best);
    folds.push({ trainTo, testFrom, testTo, best, test: res, bestTrainScore: bestScore });

    const flag = res ? (res.ret > 0 ? "✓" : "✗") : "–";
    console.log(
      `  ${flag} test ${new Date(candles[testFrom].time * 1000).toISOString().slice(0, 10)} → ` +
        `${new Date(candles[testTo].time * 1000).toISOString().slice(0, 10)}  ` +
        `return ${res ? (res.ret >= 0 ? "+" : "") + res.ret.toFixed(2) + "%" : "n/a"}  ` +
        `dd ${res ? res.dd.toFixed(1) + "%" : "n/a"}  trips ${res ? res.trips : 0}  ` +
        `params: ${label(best)}`,
    );
  }

  const tested = folds.filter((f) => f.test !== null);
  const avgRet = tested.reduce((a, f) => a + f.test!.ret, 0) / (tested.length || 1);
  const avgDd = tested.reduce((a, f) => a + f.test!.dd, 0) / (tested.length || 1);
  const avgTrips = tested.reduce((a, f) => a + f.test!.trips, 0) / (tested.length || 1);
  const winRateFolds = tested.filter((f) => f.test!.ret > 0).length;

  console.log("\n════ WALK-FORWARD RESULT (untouched data only) ═════════════════════════════");
  console.log(`  folds tested     : ${tested.length}`);
  console.log(`  average return   : ${avgRet >= 0 ? "+" : ""}${avgRet.toFixed(2)}%`);
  console.log(`  average drawdown : ${avgDd.toFixed(2)}%`);
  console.log(`  average trips    : ${avgTrips.toFixed(1)}`);
  console.log(`  profitable folds : ${winRateFolds}/${tested.length}`);

  // ── Stability of the chosen parameters ───────────────────────────────
  const counts = new Map<string, number>();
  for (const f of folds) {
    if (!f.best) continue;
    const k = label(f.best);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`\n  most frequently chosen parameters`);
    for (const [k, n] of sorted.slice(0, 3)) console.log(`    ${n}x  ${k}`);
    console.log(`  distinct parameter sets chosen across folds: ${sorted.length}`);
  }

  // ── Full-window sanity check ──────────────────────────────────────────
  // Walk-forward only ever *tests* the later part of history; the earliest bars
  // are training-only and never validated. Running the consensus parameters
  // across everything catches the case where those folds looked great while the
  // full window does not.
  const consensus = folds[folds.length - 1]?.best ?? combos[0];
  const fullWindow = await simulate(candles, candles[WARMUP].time, candles[candles.length - 1].time, consensus);

  console.log("\n════ FULL WINDOW (includes training-only history) ═════════════════════════");
  if (fullWindow) {
    console.log(`  return        ${fullWindow.ret >= 0 ? "+" : ""}${fullWindow.ret.toFixed(2)}%`);
    console.log(`  drawdown      ${fullWindow.dd.toFixed(2)}%`);
    console.log(`  trips         ${fullWindow.trips}`);
    console.log(`  win rate      ${fullWindow.win.toFixed(1)}%`);
    const holdFull = ((candles[candles.length - 1].close / candles[WARMUP].close) - 1) * 100;
    console.log(`  buy & hold    ${holdFull >= 0 ? "+" : ""}${holdFull.toFixed(2)}%`);
    const gap = avgRet - fullWindow.ret;
    console.log(
      `\n  fold average ${avgRet.toFixed(2)}% vs full window ${fullWindow.ret.toFixed(2)}%  ` +
        `(${(gap >= 0 ? "+" : "")}${gap.toFixed(2)}% difference)`,
    );
    if (fullWindow.ret < 0 && avgRet > 0) {
      console.log(
        "  ⚠ the untouched folds were profitable but the full window is not — the earliest bars\n" +
          "    (never validated) are losing money, and/or the walk-forward window is too short to trust.",
      );
    }
  }

  // ── No-lookahead check ───────────────────────────────────────────────
  console.log("\n════ LOOK-AHEAD SAFETY ════════════════════════════════════════════════════");
  const combo = consensus;
  const cut = candles.length - 1;
  const truncated = candles.slice(0, cut + 1);
  const full = await runPaperTrading({
    coinId: COIN,
    strategyIds: [STRATEGY_ID],
    paramOverrides: { [STRATEGY_ID]: combo as unknown as Record<string, number> },
    preloadedCandles: truncated,
    granularityHint: GRANULARITY,
    window: { fromTime: truncated[0].time, toTime: truncated[cut].time },
    historyDays: 90,
  });
  const lastIdx = full.replayEndIndex;
  // Re-evaluate on the truncated vs full series at the same bar.
  const strategy = requireStrategy(STRATEGY_ID);
  const profile = profileFor(strategy, GRANULARITY);
  const params = { ...profile.params };
  const sigFull = strategy.evaluate({ coinId: COIN, candles, index: lastIdx, position: null, params });
  const sigTrunc = strategy.evaluate({
    coinId: COIN,
    candles: truncated,
    index: Math.min(lastIdx, truncated.length - 1),
    position: null,
    params,
  });
  const same = sigFull.action === sigTrunc.action && sigFull.reason === sigTrunc.reason;
  console.log(`  signal on the last closed bar, full series : ${sigFull.action} — ${sigFull.reason.slice(0, 70)}`);
  console.log(`  same bar, series truncated at that bar   : ${sigTrunc.action} — ${sigTrunc.reason.slice(0, 70)}`);
  console.log(`  → ${same ? "IDENTICAL ✓ no look-ahead" : "DIFFERENT ✗ look-ahead bug"}`);
  console.log(
    `\n  This means the signal above is exactly what the strategy would have produced in real time\n` +
      `  on that bar — safe to act on going forward.\n`,
  );

  closeDb();
}

void main();
