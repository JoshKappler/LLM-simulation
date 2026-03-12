import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { OptimizationJob } from "@/lib/types";
import { abortJob, isJobRegistered } from "@/lib/optimizer/jobRegistry";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");

export async function POST(req: NextRequest) {
  const { jobId } = (await req.json()) as { jobId: string };
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return NextResponse.json({ error: "invalid jobId" }, { status: 400 });
  }

  try {
    const statePath = path.join(OPT_DIR, jobId, "state.json");

    if (isJobRegistered(jobId)) {
      // Orchestrator is running — abort the signal and let the orchestrator write
      // its own "stopped" status. Do NOT touch state.json here; a concurrent write
      // would race with orchestrator population updates and corrupt state.
      abortJob(jobId);
    } else {
      // No live orchestrator (server restart, process died) — safe to update state directly.
      const raw = await readFile(statePath, "utf-8");
      const job = JSON.parse(raw) as OptimizationJob;
      job.stopFlag = true;
      job.status = "stopped";
      job.completedAt = new Date().toISOString();
      await writeFile(statePath, JSON.stringify(job, null, 2));
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
}
