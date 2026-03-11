import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import type { OptimizationJob } from "@/lib/types";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  try {
    const raw = await readFile(path.join(OPT_DIR, jobId, "state.json"), "utf-8");
    const job = JSON.parse(raw) as OptimizationJob;
    return NextResponse.json(job);
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
}
