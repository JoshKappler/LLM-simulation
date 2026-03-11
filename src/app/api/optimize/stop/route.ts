import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { OptimizationJob } from "@/lib/types";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");

export async function POST(req: NextRequest) {
  const { jobId } = (await req.json()) as { jobId: string };
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  try {
    const raw = await readFile(path.join(OPT_DIR, jobId, "state.json"), "utf-8");
    const job = JSON.parse(raw) as OptimizationJob;
    job.stopFlag = true;
    await writeFile(path.join(OPT_DIR, jobId, "state.json"), JSON.stringify(job, null, 2));
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
}
