/**
 * The eight coins Ryomen trades. Each coin is treated as an independent unit:
 * its own bot, its own strategy assignment, its own dashboard and its own
 * paper-trading history.
 *
 * These are deliberately hard-coded. Ryomen is an automated system — there is
 * no UI to add, remove or reconfigure coins.
 */

export interface CoinDefinition {
  /** CoinGecko asset id (used in API paths). */
  id: string;
  /** Ticker symbol shown in the UI. */
  symbol: string;
  /** Human readable name. */
  name: string;
  /** Accent colour used by the dashboard. */
  color: string;
  /** Short thesis describing why the bot trades this asset. */
  thesis: string;
}

export const COINS: readonly CoinDefinition[] = Object.freeze([
  {
    id: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
    color: "#f7931a",
    thesis: "Market leader. Trend-following on the highest-liquidity pair.",
  },
  {
    id: "ethereum",
    symbol: "ETH",
    name: "Ethereum",
    color: "#627eea",
    thesis: "Large-cap beta. Trend + momentum blend with volatility guards.",
  },
  {
    id: "solana",
    symbol: "SOL",
    name: "Solana",
    color: "#14f195",
    thesis: "High-beta L1. Breakout hunting in trending regimes.",
  },
  {
    id: "dogecoin",
    symbol: "DOGE",
    name: "Dogecoin",
    color: "#c2a633",
    thesis: "Meme momentum. Mean-reversion on exhaustion spikes.",
  },
  {
    id: "binancecoin",
    symbol: "BNB",
    name: "BNB",
    color: "#f0b90b",
    thesis: "Exchange-blue-chip. Steady trend participation.",
  },
  {
    id: "hyperliquid",
    symbol: "HYPE",
    name: "Hyperliquid",
    color: "#97fce4",
    thesis: "Young high-volatility asset. Strict risk limits, breakout bias.",
  },
  {
    id: "tron",
    symbol: "TRX",
    name: "Tron",
    color: "#eb0029",
    thesis: "Low-volatility range trader. Band reversion specialist.",
  },
  {
    id: "zcash",
    symbol: "ZEC",
    name: "Zcash",
    color: "#f4b728",
    thesis: "Privacy-sector cyclical. Momentum confirmed by trend filter.",
  },
] as const);

export const COIN_IDS = COINS.map((c) => c.id);

const BY_ID = new Map(COINS.map((c) => [c.id, c]));

export function getCoin(id: string): CoinDefinition | undefined {
  return BY_ID.get(id);
}

export function isKnownCoin(id: string): boolean {
  return BY_ID.has(id);
}
