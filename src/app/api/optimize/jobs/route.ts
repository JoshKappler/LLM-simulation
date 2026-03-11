import { NextResponse } from "next/server";
import { readdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";
import type { OptimizationJob, JobSummary } from "@/lib/types";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");
const STALE_MS = 2 * 60 * 1000; // 2 minutes

export async function GET() {
  try {
    const dirs = await readdir(OPT_DIR);
    const summaries: JobSummary[] = [];

    for (const dir of dirs) {
      try {
        const statePath = path.join(OPT_DIR, dir, "state.json");
        const raw = await readFile(statePath, "utf-8");
        const job = JSON.parse(raw) as OptimizationJob;

        // Detect stale "running" jobs (process died without updating status)
        if (job.status === "running") {
          const { mtimeMs } = await stat(statePath);
          if (Date.now() - mtimeMs > STALE_MS) {
            job.status = "error";
            job.lastError = "Process terminated unexpectedly";
            job.completedAt = new Date(mtimeMs).toISOString();
            await writeFile(statePath, JSON.stringify(job, null, 2));
          }
        }

        const bestScore =
          job.population.length > 0
            ? job.population.reduce<number | null>((best, v) => {
                const s = v.rating?.total ?? null;
                if (s === null) return best;
                return best === null ? s : Math.max(best, s);
              }, null)
            : null;
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
