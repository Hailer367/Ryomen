/**
 * Run every bot's default strategy, one coin at a time.
 *
 *   npm run backtest:all
 *   npm run backtest:all -- sma-golden-cross   # run one strategy across the fleet
 *
 * Sequential on purpose: CoinGecko's free tier would reject a parallel burst,
 * and each coin is an independent bot anyway.
 */
import { COIN_IDS, getCoin } from "../src/lib/coins";
import { primaryStrategyId, requireBot } from "../src/lib/bot/config";
import { runPaperTrading } from "../src/lib/paper/engine";
import { savePaperRun } from "../src/lib/paper/store";
import { formatPct } from "../src/lib/format";

const override = process.argv.slice(2).find((a) => !/^\d+$/.test(a)) ?? null;

async function main() {
  const rows: string[] = [];
  const failures: string[] = [];

  for (const coinId of COIN_IDS) {
    const coin = getCoin(coinId)!;
    const bot = requireBot(coinId);
    const strategyId = override ?? primaryStrategyId(bot) ?? bot.assignments[0].strategyId;

    if (!bot.assignments.some((a) => a.strategyId === strategyId)) {
      process.stdout.write(`  ${coin.symbol.padEnd(5)} skipped — ${strategyId} not assigned\n`);
      continue;
    }

    process.stdout.write(`  ${coin.symbol.padEnd(5)} ${strategyId.padEnd(20)} `);
    try {
      const result = await runPaperTrading({
        coinId,
        strategyIds: [strategyId],
        historyDays: typeof bot.market.days === "number" ? bot.market.days : 90,
      });
      savePaperRun(result);
      rows.push(
        `${coin.symbol.padEnd(5)} ${strategyId.padEnd(20)} ${formatPct(result.totalReturnPct).padStart(9)}  ` +
          `bh ${formatPct(result.buyHoldReturnPct).padStart(9)}  ` +
          `dd -${result.maxDrawdownPct.toFixed(1).padStart(5)}%  ` +
          `win ${result.winRatePct.toFixed(0).padStart(3)}%  ` +
          `trips ${String(result.roundTrips).padStart(3)}`,
      );
      process.stdout.write("done\n");
    } catch (err) {
      process.stdout.write(`failed: ${(err as Error).message}\n`);
      failures.push(`${coin.symbol}: ${(err as Error).message}`);
    }
  }

  console.log("\n════ Fleet results ════════════════════════════════════════════════════════");
  for (const row of rows) console.log("  " + row);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log("    " + f);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Fleet backtest failed:", (err as Error).message);
  process.exit(1);
});
