"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface CoinRef {
  id: string;
  symbol: string;
}

/**
 * Runs every bot's paper-trading replay in sequence, one coin at a time.
 * Sequential by design: CoinGecko's free tier would reject a parallel burst,
 * and each bot is a fully independent unit anyway.
 */
export function RunAllBots({ coins }: { coins: CoinRef[] }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAll() {
    setRunning(true);
    setError(null);
    setDone(0);
    for (const coin of coins) {
      setCurrent(coin.symbol);
      try {
        const res = await fetch(`/api/coins/${coin.id}/paper-run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Run failed for ${coin.symbol}`);
        }
      } catch (err) {
        setError((err as Error).message);
        break;
      }
      setDone((d) => d + 1);
    }
    setCurrent(null);
    setRunning(false);
    router.refresh();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {running && (
        <span className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
          {done}/{coins.length} done{current ? ` · running ${current}…` : ""}
        </span>
      )}
      {error && (
        <span className="mono" style={{ fontSize: 11.5, color: "var(--red)" }}>
          {error}
        </span>
      )}
      <button className="btn btn-primary btn-sm" onClick={runAll} disabled={running}>
        {running ? <span className="spin" /> : null}
        {running ? "Running fleet…" : "Run all bots"}
      </button>
    </div>
  );
}
