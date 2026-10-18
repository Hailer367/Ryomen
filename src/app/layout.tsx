import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ryomen — Automated Crypto Trading",
  description:
    "Ryomen runs independent, code-defined trading strategies for eight crypto assets against CoinGecko market data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark">両</span>
              <span>RYOMEN</span>
            </Link>
            <Nav />
            <div className="spacer" />
            <span className="badge badge-paper" title="Live trading is disabled. All execution is simulated against real historical data.">
              <span className="dot" />
              Paper Mode
            </span>
          </header>
          <main className="content">{children}</main>
          <footer className="footer">
            Ryomen · automated strategy engine · market data by CoinGecko · strategies are permanent and
            non-editable by design · no manual trading interface
          </footer>
        </div>
      </body>
    </html>
  );
}
