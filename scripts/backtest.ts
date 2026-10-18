/**
 * Run a single bot's strategy over historical data from the command line.
 *
 *   npm run backtest -- bitcoin
 *   npm run backtest -- solana 90 sma-golden-cross
 *   npm run backtest -- bitcoin 365 macd-trend
 *
 * A session runs exactly one strategy; it defaults to the bot's default.
 */
import { COIN_IDS, getCoin } from "../src/lib/coins";
import { listStrategies, requireStrategy } from "../src/lib/strategies";
import { primaryStrategyId, requireBot } from "../src/lib/bot/config";
import { runPaperTrading } from "../src/lib/paper/engine";
import { savePaperRun } from "../src/lib/paper/store";
import { formatPct, formatUsd } from "../src/lib/format";

async function main() {
  const coinId = process.argv[2] ?? "bitcoin";
  const daysArg = process.argv[3] ? Number(process.argv[3]) : null;
  const strategyArg = process.argv[4] ?? null;

  if (!COIN_IDS.includes(coinId)) {
    console.error(`Unknown coin "${coinId}". Choose one of: ${COIN_IDS.join(", ")}`);
    process.exit(1);
  }

  const coin = getCoin(coinId)!;
  const bot = requireBot(coinId);
  const strategyId = strategyArg ?? primaryStrategyId(bot) ?? bot.assignments[0].strategyId;

  if (!bot.assignments.some((a) => a.strategyId === strategyId)) {
    console.error(`"${strategyId}" is not assigned to the ${coinId} bot.`);
    console.error(`Available: ${bot.assignments.map((a) => a.strategyId).join(", ")}`);
    console.error(`Library:   ${listStrategies().map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  const strategy = requireStrategy(strategyId);
  console.log(`\n▶ ${bot.name}  ·  ${coin.name} (${coin.symbol})`);
  console.log(`  strategy : ${strategy.name} [${strategy.id}]`);

  const result = await runPaperTrading({
    coinId,
    strategyIds: [strategyId],
    historyDays: daysArg ?? (typeof bot.market.days === "number" ? bot.market.days : 90),
  });

  const runId = savePaperRun(result);

  console.log(`  window   : ${result.days}d @ ${result.granularity} (${result.candlesUsed} bars, warm-up ${result.warmupBars})`);
  console.log(`  return   : ${formatPct(result.totalReturnPct)}   (buy&hold ${formatPct(result.buyHoldReturnPct)})`);
  console.log(`  equity   : ${formatUsd(result.finalEquity)} from ${formatUsd(result.startingCash)}`);
  console.log(`  max DD   : -${result.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  win rate : ${result.winRatePct.toFixed(1)}% over ${result.roundTrips} round trips`);
  console.log(`  sharpe   : ${result.sharpe === null ? "—" : result.sharpe.toFixed(2)}`);
  console.log(`  saved    : ${runId}\n`);
}

main().catch((err) => {
  console.error("Backtest failed:", (err as Error).message);
  process.exit(1);
});
