import { NextResponse } from "next/server";
import { readdir, readFile } from "fs/promises";
import path from "path";
import type { OptimizationJob, JobSummary } from "@/lib/types";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");

export async function GET() {
  try {
    const dirs = await readdir(OPT_DIR);
    const summaries: JobSummary[] = [];

    for (const dir of dirs) {
      try {
        const raw = await readFile(path.join(OPT_DIR, dir, "state.json"), "utf-8");
        const job = JSON.parse(raw) as OptimizationJob;
        const bestScore =
          job.population.length > 0 ? (job.population[0].rating?.total ?? null) : null;
        summaries.push({
          id: job.id,
          seedConfigName: job.seedConfigName,
          createdAt: job.createdAt,
          status: job.status,
          currentGeneration: job.currentGeneration,
          maxGenerations: job.maxGenerations,
          bestScore,
        });
      } catch { /* skip */ }
    }

    summaries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json({ jobs: summaries });
  } catch {
    return NextResponse.json({ jobs: [] });
  }
}
