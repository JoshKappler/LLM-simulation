import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir } from "fs/promises";
import path from "path";
import type { OptimizationJob, GenerationRecord } from "@/lib/types";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const raw = await readFile(path.join(OPT_DIR, id, "state.json"), "utf-8");
    const job = JSON.parse(raw) as OptimizationJob;

    // Load generation records
    const generations: GenerationRecord[] = [];
    try {
      const genDir = path.join(OPT_DIR, id, "generations");
      const files = await readdir(genDir);
      for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
        try {
          const genRaw = await readFile(path.join(genDir, file), "utf-8");
          generations.push(JSON.parse(genRaw) as GenerationRecord);
        } catch { /* skip */ }
      }
    } catch { /* no generations yet */ }

    return NextResponse.json({ job, generations });
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
}
