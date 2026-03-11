/**
 * Orchestrator — manages the full optimization generation loop.
 * Runs headless simulations, rates them, mutates top performers, and
 * persists state to disk. Emits SSE events via the event bus.
 */

import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import path from "path";
import type {
  OptimizationJob,
  OptimizationEvent,
  RatedConfig,
  GenerationRecord,
} from "../types";
import { runHeadless } from "./executor";
import { rateTranscript } from "./judge";
import { applyMutation, getMutationPlan } from "./mutator";
import { emitJobEvent, cleanupJobBus } from "./eventBus";

const OPT_DIR = path.join(process.cwd(), "optimization");

async function ensureJobDir(jobId: string) {
  await mkdir(path.join(OPT_DIR, jobId, "generations"), { recursive: true });
}

async function readState(jobId: string): Promise<OptimizationJob> {
  const raw = await readFile(path.join(OPT_DIR, jobId, "state.json"), "utf-8");
  return JSON.parse(raw) as OptimizationJob;
}

async function writeState(job: OptimizationJob): Promise<void> {
  await writeFile(
    path.join(OPT_DIR, job.id, "state.json"),
    JSON.stringify(job, null, 2),
  );
}

async function appendEvent(jobId: string, event: OptimizationEvent): Promise<void> {
  await appendFile(
    path.join(OPT_DIR, jobId, "events.ndjson"),
    JSON.stringify(event) + "\n",
  );
}

function emit(jobId: string, event: OptimizationEvent): void {
  emitJobEvent(jobId, event);
  appendEvent(jobId, event).catch(() => {});
}

function getElite(population: RatedConfig[]): RatedConfig | null {
  if (population.length === 0) return null;
  return population.reduce((best, c) =>
    (c.rating?.total ?? -1) > (best.rating?.total ?? -1) ? c : best,
  );
}

function getSecondBest(population: RatedConfig[]): RatedConfig | null {
  if (population.length < 2) return null;
  const sorted = [...population].sort(
    (a, b) => (b.rating?.total ?? -1) - (a.rating?.total ?? -1),
  );
  return sorted[1];
}

function updatePopulation(population: RatedConfig[], newVariant: RatedConfig): RatedConfig[] {
  const updated = [...population, newVariant];
  updated.sort((a, b) => (b.rating?.total ?? -1) - (a.rating?.total ?? -1));
  return updated.slice(0, 10); // keep top 10 all-time
}

export async function runOptimizationJob(jobId: string): Promise<void> {
  try {
    await ensureJobDir(jobId);
    let job = await readState(jobId);

    while (job.currentGeneration <= job.maxGenerations && !job.stopFlag) {
      const genIndex = job.currentGeneration;
      const genStarted = new Date().toISOString();

      // Determine parent elite
      const elite = getElite(job.population);
      const parentConfig = elite?.config ?? job.seedConfig;

      // Second best for crossover
      const secondBest = getSecondBest(job.population);

      const mutationPlan = getMutationPlan(job.variantsPerGeneration);
      const variantResults: RatedConfig[] = [];

      for (let vi = 0; vi < job.variantsPerGeneration; vi++) {
        // Re-read state to check stop flag
        try {
          job = await readState(jobId);
        } catch { /* use existing */ }
        if (job.stopFlag) break;

        const mutField = mutationPlan[vi];

        // Generate mutated config
        let mutatedConfig = parentConfig;
        let mutQuality: "ok" | "suspect" = "ok";

        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          mutationField: mutField,
        });

        if (mutField !== "seed") {
          try {
            const mutation = await applyMutation(
              parentConfig,
              mutField,
              job.mutationModel,
              mutField === "crossover" && secondBest ? secondBest.config : undefined,
            );
            mutatedConfig = mutation.config;
            mutQuality = mutation.quality;
          } catch {
            mutatedConfig = parentConfig;
            mutQuality = "suspect";
          }
        }

        // Run headless simulation
        const runId = String(Date.now());
        const stopFlag = { current: false };

        const { turns, terminationReason } = await runHeadless(
          mutatedConfig,
          {
            maxTurns: job.maxTurnsPerRun,
            temperature: job.temperature,
            contextWindow: 12,
          },
          (turn) => {
            emit(jobId, {
              type: "turn_complete",
              jobId,
              generation: genIndex,
              variant: vi,
              turn,
            });
          },
        );
        void stopFlag;

        emit(jobId, {
          type: "run_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          runId,
          turnCount: turns.length,
        });

        // Rate the transcript
        const rating = await rateTranscript(
          turns,
          mutatedConfig.situation,
          job.judgeModel,
        );

        emit(jobId, {
          type: "rating_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          rating,
        });

        const ratedVariant: RatedConfig = {
          config: mutatedConfig,
          runId,
          turns,
          rating,
          turnCount: turns.length,
          generationIndex: genIndex,
          variantIndex: vi,
          mutationField: mutField,
          mutationQuality: mutQuality,
          parentConfigName: parentConfig.name,
          terminationReason,
        };

        variantResults.push(ratedVariant);
        job.population = updatePopulation(job.population, ratedVariant);
        await writeState(job);
      }

      // Find generation elite
      const genElite = getElite(variantResults) ?? variantResults[0];
      const eliteIndex = variantResults.indexOf(genElite);

      // Write generation record
      const genRecord: GenerationRecord = {
        index: genIndex,
        startedAt: genStarted,
        completedAt: new Date().toISOString(),
        variants: variantResults,
        eliteIndex: eliteIndex >= 0 ? eliteIndex : 0,
      };

      const genPadded = String(genIndex).padStart(3, "0");
      await writeFile(
        path.join(OPT_DIR, jobId, "generations", `gen-${genPadded}.json`),
        JSON.stringify(genRecord, null, 2),
      );

      emit(jobId, {
        type: "generation_complete",
        jobId,
        generation: genIndex,
        elite: genElite
          ? {
              total: genElite.rating?.total ?? 0,
              summary: genElite.rating?.summary ?? "",
              mutationField: genElite.mutationField,
            }
          : undefined,
      });

      job.currentGeneration++;
      job = await readState(jobId);

      if (job.stopFlag) {
        job.status = "stopped";
        job.completedAt = new Date().toISOString();
        await writeState(job);
        emit(jobId, { type: "job_complete", jobId });
        cleanupJobBus(jobId);
        return;
      }

      if (genIndex >= job.maxGenerations) break;
    }

    job = await readState(jobId);
    job.status = "complete";
    job.completedAt = new Date().toISOString();
    await writeState(job);
    emit(jobId, { type: "job_complete", jobId });
    cleanupJobBus(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const job = await readState(jobId);
      job.status = "error";
      job.lastError = message;
      job.completedAt = new Date().toISOString();
      await writeState(job);
    } catch { /* best effort */ }
    emit(jobId, { type: "error", jobId, message });
    cleanupJobBus(jobId);
  }
}
