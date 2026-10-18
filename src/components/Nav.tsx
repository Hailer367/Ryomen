"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COINS } from "@/lib/coins";

export function Nav() {
  const pathname = usePathname();
  const isCoinPage = (id: string) => pathname === `/coins/${id}`;

  return (
    <nav className="nav">
      <Link href="/" style={{ color: pathname === "/" ? "var(--text)" : undefined, background: pathname === "/" ? "var(--bg-elev-2)" : undefined }}>
        Overview
      </Link>
      {COINS.map((c) => (
        <Link
          key={c.id}
          href={`/coins/${c.id}`}
          style={{
            color: isCoinPage(c.id) ? c.color : undefined,
            background: isCoinPage(c.id) ? "var(--bg-elev-2)" : undefined,
            fontSize: 12,
          }}
          title={c.name}
        >
          {c.symbol}
        </Link>
      ))}
      <Link
        href="/strategies"
        style={{
          color: pathname === "/strategies" ? "var(--text)" : undefined,
          background: pathname === "/strategies" ? "var(--bg-elev-2)" : undefined,
        }}
      >
        Strategies
      </Link>
    </nav>
  );
}
