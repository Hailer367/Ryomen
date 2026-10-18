import { listStrategies } from "@/lib/strategies";
import { listBots } from "@/lib/bot/config";
import { getCoin } from "@/lib/coins";

export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  const strategies = listStrategies();
  const bots = listBots();

  return (
    <>
      <h1 className="page-title">Strategy Library</h1>
      <p className="page-sub">
        Every strategy below is defined in source code, deep-frozen at startup, and referenced by identity. Ryomen
        exposes no interface to create, edit, or delete them — the dashboard can only read.
      </p>

      <div className="notice notice-warn" style={{ marginBottom: 22 }}>
        🔒 <strong>Immutable by design.</strong> A strategy&apos;s id keys its trade history, so changing one silently
        would corrupt every paper run that used it. Modify them in <code>src/lib/strategies/builtin.ts</code> and
        restart the process instead.
      </div>

      {strategies.map((s) => {
        const users = bots
          .filter((b) => b.assignments.some((a) => a.strategyId === s.id))
          .map((b) => ({
            coin: getCoin(b.coinId),
            weight: b.assignments.find((a) => a.strategyId === s.id)!.weight,
          }));

        return (
          <div key={s.id} className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h3>{s.name}</h3>
                <span className="chip">{s.category}</span>
                <span className="chip mono">{s.id}</span>
              </div>
              <span className="locked-note">🔒 read-only</span>
            </div>

            <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: -4, marginBottom: 10 }}>{s.description}</p>
            <p style={{ fontSize: 12, color: "var(--text-faint)", fontStyle: "italic", marginBottom: 14 }}>
              {s.philosophy}
            </p>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  Default Parameters
                </div>
                <div className="strategy-params">
                  {s.paramsMeta.map((m) => (
                    <span key={m.key} className="param-pill">
                      {m.label} = {s.defaultParams[m.key]}
                      {m.min !== undefined ? ` (${m.min}–${m.max})` : ""}
                    </span>
                  ))}
                </div>
              </div>
              {s.granularityProfiles && Object.keys(s.granularityProfiles).length > 0 && (
                <div>
                  <div className="section-title" style={{ marginBottom: 6 }}>
                    Per Candle Size
                  </div>
                  <div className="strategy-params">
                    {Object.entries(s.granularityProfiles).map(([g, p]) => (
                      <span key={g} className="param-pill" title={`warm-up ${p.minCandles} bars`}>
                        {g}: {p.params.fast}/{p.params.slow}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  Deployed On
                </div>
                <div className="strategy-params">
                  {users.map((u, i) => (
                    <span
                      key={i}
                      className="param-pill"
                      style={{ color: u.coin?.color ?? "var(--text-faint)", borderColor: "var(--border)" }}
                    >
                      {u.coin?.symbol ?? "?"} · w{u.weight.toFixed(2)}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  Warm-up
                </div>
                <span className="param-pill">{s.minCandles} candles</span>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
