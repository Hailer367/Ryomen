export function formatUsd(value: number | null | undefined, opts: { compact?: boolean; decimals?: number } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (opts.compact && Math.abs(value) >= 1000) return `$${formatCompact(value)}`;
  const decimals = opts.decimals ?? (Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 2 : 6);
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
}

export function formatPct(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function changeClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "flat";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

export function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function formatDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
