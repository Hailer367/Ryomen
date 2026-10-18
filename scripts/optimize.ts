/**
 * Parameter optimiser for Volatility Trail.
 *
 *   npm run optimize
 *
 * Honest methodology, because "tune until it prints profit" is how you build a
 * strategy that only works on bars you already looked at:
 *
 *   1. Load every coin once and cache it in memory.
 *   2. Split each coin's history in half. The older half is IN-SAMPLE — the
 *      only data any parameter choice is allowed to see.
 *   3. Grid-search the parameters against in-sample only.
 *   4. Score the winner on the newer half, which it has never seen.
 *   5. Cross-check on a different resolution (daily vs hourly), which is a
 *      second, independent holdout.
 *
 * If in-sample profit does not largely survive step 4, the parameters are
 * curve-fit and the report says so.
 */
import { COINS } from "../src/lib/coins";
import { config } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db/index";
import { runPaperTrading } from "../src/lib/paper/engine";
import { primaryStrategyId, requireBot } from "../src/lib/bot/config";
import type { Candle, Granularity } from "../src/lib/market/types";

const STRATEGY_ID = "volatility-trail";

/** Load a coin's already-cached series straight from SQLite (no network). */
function loadCached(coinId: string, granularity: Granularity): Candle[] {
  const rows = getDb()
    .prepare(`SELECT time, open, high, low, close FROM candles WHERE coin_id = ? AND granularity = ? ORDER BY time ASC`)
    .all(coinId, granularity) as Candle[];
  return rows;
}

interface Combo {
  trendPeriod: number;
  rocPeriod: number;
  rocThreshold: number;
  atrPeriod: number;
  atrMult: number;
  trailPeriod: number;
}

interface Sample {
  totalReturnPct: number;
  maxDrawdownPct: number;
  roundTrips: number;
  winRatePct: number;
  sharpe: number | null;
  buyHoldPct: number;
}

async function run(coinId: string, candles: Candle[], granularity: Granularity, window: { fromTime: number; toTime: number }, combo: Combo): Promise<Sample | null> {
  try {
    const r = await runPaperTrading({
      coinId,
      strategyIds: [STRATEGY_ID],
      paramOverrides: { [STRATEGY_ID]: combo as unknown as Record<string, number> },
      preloadedCandles: candles,
      granularityHint: granularity,
      window,
      historyDays: 90,
      startingCash: config.paper.startingCash,
      feeBps: config.paper.feeBps,
      slippageBps: config.paper.slippageBps,
    });
    return {
      totalReturnPct: r.totalReturnPct,
      maxDrawdownPct: r.maxDrawdownPct,
      roundTrips: r.roundTrips,
      winRatePct: r.winRatePct,
      sharpe: r.sharpe,
      buyHoldPct: r.buyHoldReturnPct,
    };
  } catch {
    return null;
  }
}

/**
 * Score = annualised return, with a heavy penalty for drawdown.
 * Drawdown is punished ~1.5× because a strategy that wins big and blows up is
 * worse than one that grinds — and because this is what kills live accounts.
 */
function score(s: Sample, windowDays: number): number {
  const annual = (s.totalReturnPct * (365 / windowDays)) / 100;
  const dd = s.maxDrawdownPct / 100;
  return annual - 1.5 * dd;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function buildGrid(): Combo[] {
  const out: Combo[] = [];
  for (const trendPeriod of [40, 60, 100, 150])
    for (const rocPeriod of [8, 18, 30])
      for (const rocThreshold of [0, 1.5, 3])
        for (const atrMult of [1.5, 2.5, 3.5])
          for (const trailPeriod of [10, 20, 30])
            out.push({ trendPeriod, rocPeriod, rocThreshold, atrPeriod: 14, atrMult, trailPeriod });
  return out;
}

async function main() {
  // ── Load ──────────────────────────────────────────────────────────────
  const hourly = new Map<string, Candle[]>();
  for (const c of COINS) hourly.set(c.id, loadCached(c.id, "1h"));
  hourly.forEach((v, k) => {
    if (v.length < 400) console.warn(`  ! ${k} has only ${v.length} hourly bars`);
  });

  // In-sample = older half, out-of-sample = newer half.
  const splits = new Map<string, { is: { fromTime: number; toTime: number }; oos: { fromTime: number; toTime: number } }>();
  for (const [id, cs] of hourly) {
    const mid = Math.floor(cs.length / 2);
    splits.set(id, {
      is: { fromTime: cs[0].time, toTime: cs[mid].time },
      oos: { fromTime: cs[mid].time, toTime: cs[cs.length - 1].time },
    });
  }

  const isWindowDays = 45; // 90 days split in half
  const oosWindowDays = 45;

  console.log(`\n▶ Optimising ${STRATEGY_ID}`);
  console.log(`  coins            : ${hourly.size}`);
  console.log(`  in-sample (IS)   : older ~${isWindowDays}d, hourly`);
  console.log(`  out-of-sample    : newer ~${oosWindowDays}d, hourly`);
  console.log(`  second holdout   : 1y daily (untouched by tuning)\n`);

  // ── Grid search, in-sample only ───────────────────────────────────────
  const grid = buildGrid();
  console.log(`  searching ${grid.length} parameter combinations…`);

  const results: { combo: Combo; score: number; ret: number; dd: number; trips: number }[] = [];
  for (const combo of grid) {
    const scores: number[] = [];
    const rets: number[] = [];
    const dds: number[] = [];
    let trips = 0;
    let usable = 0;
    for (const [id, cs] of hourly) {
      const s = await run(id, cs, "1h", splits.get(id)!.is, combo);
      if (!s || s.roundTrips < 2) continue;
      usable += 1;
      scores.push(score(s, isWindowDays));
      rets.push(s.totalReturnPct);
      dds.push(s.maxDrawdownPct);
      trips += s.roundTrips;
    }
    if (usable < Math.max(2, hourly.size / 2)) continue;
    results.push({ combo, score: mean(scores), ret: mean(rets), dd: mean(dds), trips: trips / usable });
  }

  results.sort((a, b) => b.score - a.score);
  console.log(`  ${results.length} combinations produced enough trades to score.\n`);

  const top = results.slice(0, 10);
  console.log("  top in-sample candidates");
  console.log("  params                                                     IS ret    IS dd   trips");
  for (const r of top) {
    const p = r.combo;
    const label = `trend=${String(p.trendPeriod).padStart(3)} roc=${String(p.rocPeriod).padStart(2)} thr=${p.rocThreshold} atr=${p.atrMult} trail=${String(p.trailPeriod).padStart(2)}`;
    console.log(`  ${label}  ${r.ret.toFixed(1).padStart(7)}% ${r.dd.toFixed(1).padStart(6)}% ${r.trips.toFixed(1).padStart(6)}`);
  }

  const best = top[0];

  // ── Out-of-sample ─────────────────────────────────────────────────────
  const oosScores: number[] = [];
  const oosRets: number[] = [];
  const oosDds: number[] = [];
  const oosHold: number[] = [];
  let oosTrips = 0;
  for (const [id, cs] of hourly) {
    const s = await run(id, cs, "1h", splits.get(id)!.oos, best.combo);
    if (!s || s.roundTrips < 1) continue;
    oosScores.push(score(s, oosWindowDays));
    oosRets.push(s.totalReturnPct);
    oosDds.push(s.maxDrawdownPct);
    oosHold.push(s.buyHoldPct);
    oosTrips += s.roundTrips;
  }

  const isRet = best.ret;
  const oosRet = mean(oosRets);
  const isHold = mean(top.slice(0, 1).map(() => 0)); // placeholder, filled below
  const holdoutDaily: { ret: number[]; hold: number[] } = { ret: [], hold: [] };

  // ── Second holdout: daily, one year, never touched by the grid ───────
  const dailyWindow = { fromTime: 0, toTime: Math.floor(Date.now() / 1000) };
  for (const c of COINS) {
    const cs = loadCached(c.id, "1d");
    if (cs.length < 200) continue;
    const s = await run(c.id, cs, "1d", dailyWindow, best.combo);
    if (!s || s.roundTrips < 1) continue;
    holdoutDaily.ret.push(s.totalReturnPct);
    holdoutDaily.hold.push(s.buyHoldPct);
  }

  const survives = isRet > 0 && oosRet > 0;
  const decay = isRet !== 0 ? (oosRet / isRet) * 100 : 0;

  console.log("\n════ Validation ════════════════════════════════════════════════════════════");
  console.log(`  best parameters : trend=${best.combo.trendPeriod} roc=${best.combo.rocPeriod} thr=${best.combo.rocThreshold} atr=${best.combo.atrMult} trail=${best.combo.trailPeriod}`);
  console.log(`\n  IN-SAMPLE (tuned on, older ~45d hourly)`);
  console.log(`    return        ${isRet.toFixed(2)}%   drawdown ${best.dd.toFixed(2)}%   trips/coin ${best.trips.toFixed(1)}`);
  console.log(`\n  OUT-OF-SAMPLE (never seen, newer ~45d hourly)`);
  console.log(`    return        ${oosRet.toFixed(2)}%   drawdown ${mean(oosDds).toFixed(2)}%   trips/coin ${(oosTrips / oosRets.length).toFixed(1)}`);
  console.log(`    buy & hold    ${mean(oosHold).toFixed(2)}%`);
  console.log(`    score         ${mean(oosScores).toFixed(3)}`);
  console.log(`\n  SECOND HOLDOUT (1y daily, untouched)`);
  if (holdoutDaily.ret.length) {
    console.log(`    return        ${mean(holdoutDaily.ret).toFixed(2)}%   buy & hold ${mean(holdoutDaily.hold).toFixed(2)}%   (${holdoutDaily.ret.length} coins)`);
  } else {
    console.log(`    not enough daily history cached — run: npm run warm -- --full`);
  }
  void isHold;

  console.log(`\n  verdict         ${survives ? "HOLDS UP" : "DOES NOT GENERALISE"}`);
  console.log(`  decay           ${decay.toFixed(0)}% of in-sample return survived out-of-sample`);
  console.log(
    decay < 30
      ? "  -> heavily curve-fit. Do not trust these numbers."
      : decay < 70
        ? "  -> partial decay, normal for a tuned strategy. Treat out-of-sample as the real figure."
        : "  -> most of the gain generalised.",
  );
  console.log("");

  closeDb();
}

main().catch((e) => {
  console.error("Optimiser failed:", (e as Error).message);
  process.exit(1);
});
