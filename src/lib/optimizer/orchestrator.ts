/**
 * Orchestrator v2 — Population-based genetic evolution.
 *
 * Simple rules:
 *   1. Maintain a population of N prompt configs
 *   2. Each generation: run new offspring, score them, merge with survivors
 *   3. Sort by fitness, kill the bottom half
 *   4. Breed from survivors: crossover + mutation
 *   5. Best-ever config is always preserved (elitism)
 *
 * Three moving parts: mutate, run, score. That's it.
 */

import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import path from "path";
import type {
  OptimizationJob,
  OptimizationEvent,
  PromptConfig,
  RatedConfig,
  GenerationRecord,
  ConversationTurn,
} from "../types";
import { runHeadless } from "./executor";
import {
  scoreTranscript,
  mutateConfig,
  crossoverConfigs,
  fitnessToRating,
} from "./evaluator";
import { emitJobEvent, cleanupJobBus } from "./eventBus";
import { unregisterJob } from "./jobRegistry";

const OPT_DIR = path.join(process.cwd(), "optimization");
const MIN_TURNS = 6;
const DELAY_MS = 2000;

// ── Persistence ──────────────────────────────────────────────────────────────

async function ensureJobDir(id: string) {
  await mkdir(path.join(OPT_DIR, id, "generations"), { recursive: true });
}

async function readState(id: string): Promise<OptimizationJob> {
  return JSON.parse(
    await readFile(path.join(OPT_DIR, id, "state.json"), "utf-8"),
  ) as OptimizationJob;
}

async function writeState(job: OptimizationJob): Promise<void> {
  await writeFile(
    path.join(OPT_DIR, job.id, "state.json"),
    JSON.stringify(job, null, 2),
  );
}

function emit(jobId: string, event: OptimizationEvent): void {
  emitJobEvent(jobId, event);
  if (event.type !== "turn_token" && event.type !== "evaluator_token") {
    appendFile(
      path.join(OPT_DIR, jobId, "events.ndjson"),
      JSON.stringify(event) + "\n",
    ).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stopped(job: OptimizationJob, signal?: AbortSignal): boolean {
  return !!job.stopFlag || !!signal?.aborted;
}

function applyModel(
  config: PromptConfig,
  model?: string,
): PromptConfig {
  if (!model) return config;
  return {
    ...config,
    characters: (config.characters ?? []).map((c) => ({ ...c, model })),
  };
}

function effectiveScore(
  fitness: number,
  turnCount: number,
  termination: string,
): number {
  if (turnCount < MIN_TURNS) return 0;
  if (termination === "error") return 0;
  const scaled = fitness * 5; // scale 1-10 → 5-50 for UI compat
  if (termination === "looping") return Math.round(scaled * 0.5);
  if (termination === "max_turns") return Math.round(scaled * 0.85);
  return Math.round(scaled); // resolved
}

function pickTwo<T>(arr: T[]): [T, T] {
  const i = Math.floor(Math.random() * arr.length);
  let j = Math.floor(Math.random() * (arr.length - 1));
  if (j >= i) j++;
  return [arr[i], arr[j]];
}

// ── Run + Score one config ───────────────────────────────────────────────────

async function runAndScore(
  config: PromptConfig,
  job: OptimizationJob,
  genIndex: number,
  variantIndex: number,
  signal?: AbortSignal,
): Promise<RatedConfig> {
  const runConfig = applyModel(config, job.characterModel);
  const runId = String(Date.now());

  emit(job.id, {
    type: "run_start",
    jobId: job.id,
    generation: genIndex,
    variant: variantIndex,
  });

  let turns: ConversationTurn[] = [];
  let terminationReason = "error";
  let errorMessage: string | undefined;

  try {
    const result = await runHeadless(
      runConfig,
      {
        maxTurns: job.maxTurnsPerRun,
        temperature: job.temperature,
        contextWindow: 12,
        signal,
        killerFirstThreshold: 0,
        killerInterval: 4,
        onToken: (ai, name, tok) =>
          emitJobEvent(job.id, {
            type: "turn_token",
            jobId: job.id,
            generation: genIndex,
            variant: variantIndex,
            agentIndex: ai,
            agentName: name,
            token: tok,
          }),
      },
      (turn) => {
        emit(job.id, {
          type: "turn_complete",
          jobId: job.id,
          generation: genIndex,
          variant: variantIndex,
          turn,
        });
      },
    );
    turns = result.turns;
    terminationReason = result.terminationReason;
    errorMessage = result.errorMessage;
  } catch (err) {
    if (signal?.aborted) throw err;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  emit(job.id, {
    type: "run_complete",
    jobId: job.id,
    generation: genIndex,
    variant: variantIndex,
    runId,
    turnCount: turns.length,
  });

  if (terminationReason === "error") {
    emit(job.id, {
      type: "error",
      jobId: job.id,
      message: `Run failed (gen ${genIndex}, var ${variantIndex}): ${errorMessage ?? "unknown"}`,
    });
  }

  // Score
  let fitness = 0;
  let summary = "";

  if (terminationReason !== "error" && turns.length >= 2) {
    try {
      await sleep(DELAY_MS, signal);
      const scored = await scoreTranscript(turns, job.judgeModel, signal);
      fitness = scored.fitness;
      summary = scored.summary;
    } catch (err) {
      if (signal?.aborted) throw err;
      summary = "Scoring failed";
    }
  }

  const eff = effectiveScore(fitness, turns.length, terminationReason);
  const rating = fitnessToRating(fitness, summary);

  emit(job.id, {
    type: "rating_complete",
    jobId: job.id,
    generation: genIndex,
    variant: variantIndex,
    rating,
  });

  return {
    config,
    runId,
    turns,
    rating,
    turnCount: turns.length,
    generationIndex: genIndex,
    variantIndex,
    mutationField: "seed",
    parentConfigName: config.name,
    terminationReason,
    effectiveScore: eff,
  };
}

// ── Write generation record ──────────────────────────────────────────────────

async function writeGenRecord(
  jobId: string,
  genIndex: number,
  startedAt: string,
  variants: RatedConfig[],
  eliteIndex: number,
  complete = false,
): Promise<void> {
  const genRecord: GenerationRecord = {
    index: genIndex,
    startedAt,
    completedAt: complete ? new Date().toISOString() : undefined,
    complete,
    variants,
    eliteIndex,
  };
  const genPadded = String(genIndex).padStart(3, "0");
  await writeFile(
    path.join(OPT_DIR, jobId, "generations", `gen-${genPadded}.json`),
    JSON.stringify(genRecord, null, 2),
  ).catch(() => {});
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function runOptimizationJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await ensureJobDir(jobId);
    let job = await readState(jobId);

    // variantsPerGeneration is repurposed as population size
    const popSize = Math.max(4, job.variantsPerGeneration);
    const survivorCount = Math.max(2, Math.ceil(popSize / 2));

    let bestEver: RatedConfig | null = null;

    while (job.currentGeneration < job.maxGenerations && !stopped(job, signal)) {
      const gen = job.currentGeneration;
      const genStarted = new Date().toISOString();

      if (gen === 0) {
        // ════════════════════════════════════════════════════════════════════
        // GEN 0 — INITIALIZE: seed + (N-1) mutations, run all, score all
        // ════════════════════════════════════════════════════════════════════

        const population: RatedConfig[] = [];

        // Run seed
        const seedResult = await runAndScore(
          job.seedConfig,
          job,
          0,
          0,
          signal,
        );
        seedResult.mutationField = "seed";
        population.push(seedResult);

        await writeGenRecord(jobId, 0, genStarted, population, 0);

        // Generate and run N-1 mutations
        for (let i = 1; i < popSize && !stopped(job, signal); i++) {
          await sleep(DELAY_MS, signal);

          let mutated: PromptConfig;
          try {
            mutated = await mutateConfig(
              job.seedConfig,
              job.mutationModel,
              signal,
            );
          } catch (err) {
            if (signal?.aborted) throw err;
            mutated = JSON.parse(JSON.stringify(job.seedConfig));
          }

          emit(job.id, {
            type: "mutation_complete",
            jobId,
            generation: 0,
            variant: i,
            mutationField: "explore",
          });

          await sleep(DELAY_MS, signal);

          const result = await runAndScore(mutated, job, 0, i, signal);
          result.mutationField = "explore";
          population.push(result);

          await writeGenRecord(jobId, 0, genStarted, population, 0);
        }

        // Sort by effective score
        population.sort(
          (a, b) => (b.effectiveScore ?? 0) - (a.effectiveScore ?? 0),
        );
        bestEver = population[0] ?? null;
        job.population = population;

        await writeGenRecord(jobId, 0, genStarted, population, 0, true);

        emit(job.id, {
          type: "generation_complete",
          jobId,
          generation: 0,
          elite: bestEver?.rating
            ? {
                total: bestEver.rating.total,
                summary: bestEver.rating.summary,
                mutationField: bestEver.mutationField,
              }
            : undefined,
        });
      } else {
        // ════════════════════════════════════════════════════════════════════
        // GEN 1+ — EVOLUTION: select, breed, run offspring, merge
        // ════════════════════════════════════════════════════════════════════

        let pop = [...job.population];
        pop.sort(
          (a, b) => (b.effectiveScore ?? 0) - (a.effectiveScore ?? 0),
        );

        // Elitism: ensure best-ever survives
        if (bestEver && !pop.find((p) => p.runId === bestEver!.runId)) {
          pop.unshift(bestEver);
        }

        // Keep top half
        const survivors = pop.slice(0, survivorCount);

        // Breed offspring to refill population
        const offspring: RatedConfig[] = [];

        for (
          let i = 0;
          i < popSize - survivors.length && !stopped(job, signal);
          i++
        ) {
          await sleep(DELAY_MS, signal);

          let childConfig: PromptConfig;
          let origin: "crossover" | "explore";

          if (survivors.length >= 2 && Math.random() > 0.3) {
            // 70%: crossover two survivors, then mutate
            const [pa, pb] = pickTwo(survivors);
            childConfig = crossoverConfigs(pa.config, pb.config);
            try {
              childConfig = await mutateConfig(
                childConfig,
                job.mutationModel,
                signal,
              );
            } catch (err) {
              if (signal?.aborted) throw err;
              // crossover without mutation is still useful
            }
            origin = "crossover";
          } else {
            // 30%: mutate a random survivor
            const parent =
              survivors[Math.floor(Math.random() * survivors.length)];
            try {
              childConfig = await mutateConfig(
                parent.config,
                job.mutationModel,
                signal,
              );
            } catch (err) {
              if (signal?.aborted) throw err;
              childConfig = JSON.parse(JSON.stringify(parent.config));
            }
            origin = "explore";
          }

          const variantIndex = survivors.length + i;

          emit(job.id, {
            type: "mutation_complete",
            jobId,
            generation: gen,
            variant: variantIndex,
            mutationField: origin,
          });

          await sleep(DELAY_MS, signal);

          const result = await runAndScore(
            childConfig,
            job,
            gen,
            variantIndex,
            signal,
          );
          result.mutationField = origin;
          result.generationIndex = gen;
          offspring.push(result);

          // Write progress
          const progress = [
            ...survivors.map((s, si) => ({ ...s, variantIndex: si })),
            ...offspring,
          ];
          const bestIdx = progress.reduce(
            (bi, v, idx) =>
              (v.effectiveScore ?? 0) > (progress[bi].effectiveScore ?? 0)
                ? idx
                : bi,
            0,
          );
          await writeGenRecord(jobId, gen, genStarted, progress, bestIdx);
        }

        // Merge survivors + offspring, sort, trim to popSize
        const newPop = [...survivors, ...offspring];
        newPop.sort(
          (a, b) => (b.effectiveScore ?? 0) - (a.effectiveScore ?? 0),
        );

        // Update best-ever
        if (
          newPop[0] &&
          (!bestEver ||
            (newPop[0].effectiveScore ?? 0) >
              (bestEver.effectiveScore ?? 0))
        ) {
          bestEver = newPop[0];
        }

        job.population = newPop.slice(0, popSize);

        // Write final generation record
        const allVariants = [
          ...survivors.map((s, si) => ({ ...s, variantIndex: si })),
          ...offspring,
        ];
        const eliteIdx = allVariants.reduce(
          (bi, v, idx) =>
            (v.effectiveScore ?? 0) > (allVariants[bi].effectiveScore ?? 0)
              ? idx
              : bi,
          0,
        );
        await writeGenRecord(
          jobId,
          gen,
          genStarted,
          allVariants,
          eliteIdx,
          true,
        );

        emit(job.id, {
          type: "generation_complete",
          jobId,
          generation: gen,
          elite: bestEver?.rating
            ? {
                total: bestEver.rating.total,
                summary: bestEver.rating.summary,
                mutationField: bestEver.mutationField,
              }
            : undefined,
        });
      }

      job.currentGeneration++;
      await writeState(job);
      job = await readState(jobId);
    }

    // ── Job finished ──────────────────────────────────────────────────────
    job = await readState(jobId);
    job.status = signal?.aborted || job.stopFlag ? "stopped" : "complete";
    job.completedAt = new Date().toISOString();
    await writeState(job);
    emit(jobId, { type: "job_complete", jobId });
    cleanupJobBus(jobId);
    unregisterJob(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] Fatal error for job ${jobId}:`, message);
    try {
      const job = await readState(jobId);
      job.status = signal?.aborted ? "stopped" : "error";
      job.lastError = signal?.aborted ? undefined : message;
      job.completedAt = new Date().toISOString();
      await writeState(job);
    } catch {
      /* best effort */
    }
    if (!signal?.aborted) {
      emit(jobId, { type: "error", jobId, message });
    }
    emit(jobId, { type: "job_complete", jobId });
    cleanupJobBus(jobId);
    unregisterJob(jobId);
  }
}
