import { NextResponse } from "next/server";
import { isKnownCoin } from "@/lib/coins";
import { listRuns } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isKnownCoin(id)) return NextResponse.json({ error: `Unknown coin: ${id}` }, { status: 404 });
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 25);
  return NextResponse.json({ runs: listRuns(id, Number.isFinite(limit) ? limit : 25) });
}
