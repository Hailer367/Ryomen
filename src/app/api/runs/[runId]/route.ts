import { NextResponse } from "next/server";
import { deleteRun, getRun } from "@/lib/paper/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = getRun({ id: runId });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(run);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const removed = deleteRun(runId);
  if (!removed) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id: runId });
}
