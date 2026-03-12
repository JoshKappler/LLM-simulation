import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { OptimizationJob, PromptConfig } from "@/lib/types";
import { runOptimizationJob } from "@/lib/optimizer/orchestrator";
import { registerJob } from "@/lib/optimizer/jobRegistry";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");
const PROMPTS_DIR = path.join(process.cwd(), "prompts");

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    seedConfigName,
    maxGenerations = 10,
    variantsPerGeneration = 6,
    maxTurnsPerRun = 30,
    temperature = 0.85,
    judgeModel,
    mutationModel,
    characterModel,
  } = body as {
    seedConfigName: string;
    maxGenerations?: number;
    variantsPerGeneration?: number;
    maxTurnsPerRun?: number;
    temperature?: number;
    judgeModel: string;
    mutationModel: string;
    characterModel: string;
  };

  if (!judgeModel || !mutationModel || !characterModel) {
    return NextResponse.json({ error: "judgeModel, mutationModel, and characterModel are required" }, { status: 400 });
  }

  if (!seedConfigName) {
    return NextResponse.json({ error: "seedConfigName is required" }, { status: 400 });
  }

  // Clamp numeric params to sensible ranges
  const safeMaxGenerations = Math.min(100, Math.max(1, Math.round(maxGenerations)));
  const safeVariantsPerGeneration = Math.min(20, Math.max(1, Math.round(variantsPerGeneration)));
  const safeMaxTurnsPerRun = Math.min(200, Math.max(5, Math.round(maxTurnsPerRun)));
  const safeTemperature = Math.min(2, Math.max(0, temperature));

  // Load seed config — scan directory and match by internal name field
  let seedConfig: PromptConfig | null = null;
  try {
    const files = await readdir(PROMPTS_DIR);
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(path.join(PROMPTS_DIR, file), "utf-8");
        const parsed = JSON.parse(raw) as PromptConfig;
        if (parsed.name === seedConfigName) {
          seedConfig = parsed;
          break;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }

  if (!seedConfig) {
    return NextResponse.json({ error: `Prompt config "${seedConfigName}" not found` }, { status: 404 });
  }

  const jobId = String(Date.now());
  const job: OptimizationJob = {
    id: jobId,
    seedConfigName,
    seedConfig,
    createdAt: new Date().toISOString(),
    status: "running",
    currentGeneration: 0,
    maxGenerations: safeMaxGenerations,
    variantsPerGeneration: safeVariantsPerGeneration,
    maxTurnsPerRun: safeMaxTurnsPerRun,
    temperature: safeTemperature,
    judgeModel,
    mutationModel,
    ...(characterModel ? { characterModel } : {}),
    population: [],
    stopFlag: false,
  };

  await mkdir(path.join(OPT_DIR, jobId, "generations"), { recursive: true });
  await writeFile(path.join(OPT_DIR, jobId, "state.json"), JSON.stringify(job, null, 2));

  // Launch orchestrator in background (fire and forget)
  const controller = new AbortController();
  registerJob(jobId, controller);
  runOptimizationJob(jobId, controller.signal).catch((err) => {
    console.error(`Orchestrator error for job ${jobId}:`, err);
  });

  return NextResponse.json({ jobId }, { status: 201 });
}
