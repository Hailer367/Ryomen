/**
 * Warm the CoinGecko cache so browsing Ryomen costs zero API calls.
 *
 *   npm run warm          # tickers + hourly history for all 8 coins (9 calls)
 *   npm run warm -- --full   # also daily history for the 1Y view (17 calls)
 *
 * The free tier allows roughly 8-10 requests/minute, so expect this to take a
 * minute or two. It is safe to re-run; fresh copies are simply skipped.
 */
import { COINS } from "../src/lib/coins";
import { getCandles } from "../src/lib/market/service";
import { getCoinGeckoStats } from "../src/lib/coingecko/client";
import { getTickers } from "../src/lib/market/service";
import { closeDb } from "../src/lib/db/index";

const full = process.argv.includes("--full");

async function main() {
  console.log(`Warming Ryomen cache${full ? " (full)" : ""}…\n`);

  process.stdout.write("  tickers          ");
  const before = getCoinGeckoStats().requests;
  await getTickers({ force: true });
  console.log(`ok (+${getCoinGeckoStats().requests - before} requests)`);

  for (const coin of COINS) {
    process.stdout.write(`  ${coin.symbol.padEnd(5)} hourly  `);
    const b = getCoinGeckoStats().requests;
    try {
      const series = await getCandles(coin.id, { days: 90, source: "market-chart", force: true });
      console.log(`${String(series.candles.length).padStart(5)} bars (+${getCoinGeckoStats().requests - b})`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }

  if (full) {
    for (const coin of COINS) {
      process.stdout.write(`  ${coin.symbol.padEnd(5)} daily   `);
      const b = getCoinGeckoStats().requests;
      try {
        const series = await getCandles(coin.id, { days: 365, source: "market-chart", force: true });
        console.log(`${String(series.candles.length).padStart(5)} bars (+${getCoinGeckoStats().requests - b})`);
      } catch (err) {
        console.log(`FAILED: ${(err as Error).message}`);
      }
    }
  }

  const s = getCoinGeckoStats();
  console.log(
    `\nDone. ${s.requests} network requests · ${s.rateLimited} rate-limited · ` +
      `${(s.bytes / 1024).toFixed(0)} KB received.`,
  );
  console.log("Browsing the dashboard from here on makes no external calls.\n");
  closeDb();
}

main().catch((err) => {
  console.error("Warm failed:", (err as Error).message);
  process.exit(1);
});
