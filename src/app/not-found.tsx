import Link from "next/link";

export default function NotFound() {
  return (
    <div className="panel" style={{ maxWidth: 520, margin: "60px auto", textAlign: "center" }}>
      <h1 className="page-title">Not found</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Ryomen only tracks a fixed set of eight assets and their bots.
      </p>
      <Link href="/" className="btn btn-primary" style={{ marginTop: 16 }}>
        Back to fleet
      </Link>
    </div>
  );
}
