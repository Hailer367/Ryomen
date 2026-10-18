/** Quick fleet report for one strategy across every coin. */
const coins = ["bitcoin", "ethereum", "solana", "dogecoin", "binancecoin", "hyperliquid", "tron", "zcash"];
const strategyId = process.argv[2] ?? "volatility-trail";
const historyDays = Number(process.argv[3] ?? 90);

const pad = (s: unknown, n: number) => String(s).padEnd(n);
const padS = (s: unknown, n: number) => String(s).padStart(n);

interface Row {
  coin: string;
  error?: string;
  ret?: number;
  dd?: number;
  win?: number;
  trips?: number;
  sharpe?: number | null;
  bh?: number;
  fees?: number;
}

async function main() {
  const out: Row[] = [];
  for (const c of coins) {
    const res = await fetch(`http://localhost:3000/api/coins/${c}/paper-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategyId, historyDays, source: "market-chart", persist: false }),
    });
    const j = await res.json();
    if (j.error) {
      out.push({ coin: c, error: j.error });
      continue;
    }
    out.push({
      coin: c,
      ret: j.summary.totalReturnPct,
      dd: j.summary.maxDrawdownPct,
      win: j.summary.winRatePct,
      trips: j.summary.roundTrips,
      sharpe: j.summary.sharpe,
      bh: j.summary.buyHoldReturnPct,
      fees: j.trades.reduce((a: number, t: { fee: number }) => a + t.fee, 0),
    });
  }

  console.log(`\n  ${strategyId} @ ${historyDays}d`);
  console.log(
    `  ${pad("coin", 11)}${padS("return", 9)}${padS("buy&hold", 10)}${padS("drawdown", 10)}${padS("win%", 7)}${padS("trips", 7)}${padS("fees$", 9)}${padS("sharpe", 8)}`,
  );

  let wins = 0;
  for (const r of out) {
    if (r.error) {
      console.log(`  ${pad(r.coin, 11)} ERROR ${r.error}`);
      continue;
    }
    if ((r.ret ?? 0) > 0) wins += 1;
    console.log(
      `  ${pad(r.coin, 11)}${padS((r.ret ?? 0).toFixed(2) + "%", 9)}${padS((r.bh ?? 0).toFixed(2) + "%", 10)}${padS(
        (r.dd ?? 0).toFixed(2) + "%",
        10,
      )}${padS((r.win ?? 0).toFixed(0) + "%", 7)}${padS(r.trips, 7)}${padS((r.fees ?? 0).toFixed(0), 9)}${padS(
        r.sharpe === null || r.sharpe === undefined ? "—" : r.sharpe.toFixed(2),
        8,
      )}`,
    );
  }

  const good = out.filter((r) => !r.error);
  const avg = (k: keyof Row) => good.reduce((a, r) => a + ((r[k] as number) ?? 0), 0) / (good.length || 1);
  console.log(
    `  ${pad("AVERAGE", 11)}${padS(avg("ret").toFixed(2) + "%", 9)}${padS(avg("bh").toFixed(2) + "%", 10)}${padS(
      avg("dd").toFixed(2) + "%",
      10,
    )}${padS(avg("win").toFixed(0) + "%", 7)}${padS(avg("trips").toFixed(0), 7)}${padS(avg("fees").toFixed(0), 9)}`,
  );
  console.log(`  profitable on ${wins}/${good.length} coins\n`);
}

void main();
