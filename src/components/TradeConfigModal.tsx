"use client";

import { useEffect, useState } from "react";
import type { StrategySnapshotDTO } from "@/components/CoinWorkspace";

export interface TradeConfig {
  historyDays: number;
  /** A session runs exactly one strategy. */
  strategyId: string;
}

const HISTORY = [
  { key: 30, label: "30d", gran: "hourly" },
  { key: 90, label: "90d", gran: "hourly" },
  { key: 180, label: "180d", gran: "daily" },
  { key: 365, label: "1y", gran: "daily" },
] as const;

/** CoinGecko caps: 90 days of hourly data, 365 days of daily data. */
const DATA_CEILING_DAYS = { hourly: 90, daily: 365 } as const;

/**
 * How many days of *tradeable* replay a request can actually deliver.
 *
 * A strategy needs warm-up bars before it may trade, and that warm-up comes
 * from history that sits before the replay window. When the request plus its
 * warm-up exceeds CoinGecko's ceiling, the replay comes up short — so predict
 * it here rather than surprising the user after they press start.
 */
export function achievableDays(
  historyDays: number,
  strategies: StrategySnapshotDTO[],
  selectedId: string | null,
): number {
  const granularity = historyDays > 90 ? "daily" : "hourly";
  const barSeconds = granularity === "daily" ? 86_400 : 3_600;
  const ceiling = DATA_CEILING_DAYS[granularity];

  const st = strategies.find((s) => s.strategyId === selectedId);
  const profile = st?.profiles.find((p) => p.granularity === (granularity === "daily" ? "1d" : "1h"));
  const warmupBars = st ? (profile ? profile.minCandles : 55) : 0;

  const warmupDays = Math.ceil((warmupBars * barSeconds) / 86_400) + 1;
  return Math.max(0, Math.min(historyDays, ceiling - warmupDays));
}

interface Props {
  open: boolean;
  coinSymbol: string;
  strategies: StrategySnapshotDTO[];
  initial: TradeConfig;
  busy: boolean;
  onCancel: () => void;
  onStart: (config: TradeConfig) => void;
}

/**
 * Configuration pane opened by "Start paper trade".
 *
 * Everything the run needs is chosen here — how much history to replay and
 * which of the bot's permanent strategies take part — before anything is
 * computed.
 */
export function TradeConfigModal({
  open,
  coinSymbol,
  strategies,
  initial,
  busy,
  onCancel,
  onStart,
}: Props) {
  const [historyDays, setHistoryDays] = useState<number>(initial.historyDays);
  const [strategyId, setStrategyId] = useState<string>(initial.strategyId);

  useEffect(() => {
    if (!open) return;
    setHistoryDays(initial.historyDays);
    setStrategyId(initial.strategyId);
  }, [open, initial.historyDays, initial.strategyId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const primaryIds = strategies.filter((s) => s.primary).map((s) => s.strategyId);
  const activeHistory = HISTORY.find((h) => h.key === historyDays) ?? HISTORY[0];
  const valid = Boolean(strategyId);
  const selectedStrategy = strategies.find((s) => s.strategyId === strategyId) ?? null;
  const achievable = achievableDays(historyDays, strategies, strategyId);
  const shortfall = achievable < historyDays;

  function toggle(id: string) {
    setStrategyId(id);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Configure ${coinSymbol} paper trade`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(4,5,7,0.78)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 600,
          maxHeight: "88vh",
          overflowY: "auto",
          padding: 22,
          border: "1px solid var(--border)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
          <div>
            <h3 style={{ fontSize: 16 }}>Configure paper trade</h3>
            <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
              {coinSymbol} · pick how much history to replay and which strategies take part
            </div>
          </div>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        {/* History */}
        <div style={{ marginBottom: 20 }}>
          <div className="section-title">History / timeframe</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {HISTORY.map((h) => {
              const active = historyDays === h.key;
              return (
                <button
                  key={h.key}
                  onClick={() => setHistoryDays(h.key)}
                  title={`Replays on ${h.gran} candles`}
                  style={{
                    padding: "11px 8px",
                    borderRadius: 9,
                    cursor: "pointer",
                    background: active ? "var(--bg-elev-2)" : "transparent",
                    border: `1px solid ${active ? "var(--accent)" : "var(--border-soft)"}`,
                    color: active ? "var(--text)" : "var(--text-faint)",
                    font: "inherit",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{h.label}</div>
                  <div style={{ fontSize: 10.5, marginTop: 2 }}>{h.gran}</div>
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "9px 0 0" }}>
            {valid ? (
              <>
                You will watch <strong>{achievable} days</strong> of replay on {activeHistory.gran} candles.
                {shortfall && (
                  <>
                    {" "}
                    <span style={{ color: "var(--amber)" }}>
                      Short of {historyDays}d: CoinGecko only serves{" "}
                      {activeHistory.gran === "daily" ? "365" : "90"} days at this size, and part of that is spent
                      warming up the indicators.
                    </span>
                  </>
                )}
              </>
            ) : (
              "Pick a strategy to see how much history is available."
            )}
          </p>
        </div>

        {/* Strategies */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span className="section-title" style={{ margin: 0 }}>Strategy</span>
            <span className="chip">one per session</span>
            <div className="spacer" style={{ flex: 1 }} />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setStrategyId(primaryIds[0] ?? strategies[0]?.strategyId ?? "")}
            >
              Use default
            </button>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {strategies.map((st) => {
              const active = strategyId === st.strategyId;
              return (
                <button
                  key={st.strategyId}
                  onClick={() => toggle(st.strategyId)}
                  role="radio"
                  aria-checked={active}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 9,
                    cursor: "pointer",
                    background: active ? "var(--bg-elev-2)" : "transparent",
                    border: `1px solid ${active ? "var(--accent)" : "var(--border-soft)"}`,
                    color: active ? "var(--text)" : "var(--text-faint)",
                    font: "inherit",
                  }}
                >
                  <span
                    style={{
                      width: 15,
                      height: 15,
                      borderRadius: "50%",
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      background: active ? "var(--accent)" : "transparent",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 8,
                      color: "#fff",
                      flexShrink: 0,
                    }}
                  >
                    {active ? "●" : ""}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{st.name}</span>
                      {st.primary && (
                        <span className="chip" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>
                          DEFAULT
                        </span>
                      )}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                      {st.category} · weight {st.weight}
                      {st.profiles.length > 1 &&
                        ` · ${st.profiles.map((p) => `${p.granularity} ${p.params.fast}/${p.params.slow}`).join("  ")}`}
                    </span>
                  </span>
                  <div className="spacer" style={{ flex: 1 }} />
                  <span
                    className={`chip ${
                      st.signal.action === "buy"
                        ? "chip-buy"
                        : st.signal.action === "sell"
                          ? "chip-sell"
                          : "chip-hold"
                    }`}
                  >
                    {st.signal.action.toUpperCase()}
                  </span>
                </button>
              );
            })}
          </div>
          {selectedStrategy && (
            <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "10px 0 0" }}>
              <strong style={{ color: "var(--text-dim)" }}>{selectedStrategy.name}</strong> —{" "}
              {selectedStrategy.description}
            </p>
          )}
        </div>

        {/* Summary */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingTop: 14,
            borderTop: "1px solid var(--border-soft)",
          }}
        >
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
            {activeHistory.label} · {activeHistory.gran} · {achievable}d replay ·{" "}
            {selectedStrategy ? selectedStrategy.name : "no strategy"}
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onStart({ historyDays, strategyId })}
            disabled={!valid || busy}
          >
            {busy ? <span className="spin" /> : null}
            {busy ? "Preparing…" : "Start replay"}
          </button>
        </div>
      </div>
    </div>
  );
}
