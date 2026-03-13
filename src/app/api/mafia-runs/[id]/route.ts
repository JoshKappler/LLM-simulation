import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "fs/promises";
import path from "path";
import type { MafiaRunRecord } from "@/lib/mafia/types";

const DIR = path.join(process.cwd(), "mafia-runs");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const raw = await readFile(path.join(DIR, `${id}.json`), "utf-8");
    return NextResponse.json(JSON.parse(raw) as MafiaRunRecord);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await unlink(path.join(DIR, `${id}.json`)).catch(() => {});
    await unlink(path.join(DIR, `${id}.txt`)).catch(() => {});
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "failed to delete" }, { status: 500 });
  }
}
