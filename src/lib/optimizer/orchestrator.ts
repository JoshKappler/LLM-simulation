/**
 * Orchestrator — manages the full optimization generation loop.
 * Uses a single combined evaluate+mutate LLM call per variant,
 * critique-guided mutation chaining, elite carryover, effective score
 * penalties, and head-to-head comparison between generation winners.
 */

import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import path from "path";
import type {
  OptimizationJob,
  OptimizationEvent,
  PromptConfig,
  RatedConfig,
  GenerationRecord,
  MutationField,
} from "../types";
import { runHeadless } from "./executor";
import { getMutationPlan } from "./mutator";
import {
  evaluateAndMutate,
  generateMutationFromCritique,
  applyTextMutation,
  compareTranscripts,
} from "./evaluator";
import { emitJobEvent, cleanupJobBus } from "./eventBus";
import { unregisterJob } from "./jobRegistry";

const OPT_DIR = path.join(process.cwd(), "optimization");
const MIN_TURNS = 8;

// ── Persistence ────────────────────────────────────────────────────────────────

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

// ── Population helpers ─────────────────────────────────────────────────────────

function getEffective(v: RatedConfig): number {
  const eff = v.effectiveScore;
  if (eff !== undefined && eff !== null) {
    return eff + (v.rating?.total ?? 0) * 0.001;
  }
  return v.rating?.total ?? -1;
}

function getElite(population: RatedConfig[]): RatedConfig | null {
  if (population.length === 0) return null;
  return population.reduce((best, c) => (getEffective(c) > getEffective(best) ? c : best));
}

function getSecondBest(population: RatedConfig[]): RatedConfig | null {
  if (population.length < 2) return null;
  const sorted = [...population].sort((a, b) => getEffective(b) - getEffective(a));
  return sorted[1];
}

function updatePopulation(population: RatedConfig[], newVariant: RatedConfig): RatedConfig[] {
  const existing = population.findIndex((v) => v.runId === newVariant.runId);
  const updated =
    existing >= 0
      ? population.map((v, i) => (i === existing ? newVariant : v))
      : [...population, newVariant];
  updated.sort((a, b) => getEffective(b) - getEffective(a));
  return updated.slice(0, 10);
}

// ── Effective score ────────────────────────────────────────────────────────────

function computeEffectiveScore(
  rawScore: number,
  turnCount: number,
  terminationReason: string | undefined,
): number {
  if (turnCount < MIN_TURNS) return 0;
  if (terminationReason === "looping") return Math.round(rawScore * 0.5);
  if (terminationReason === "max_turns") return Math.round(rawScore * 0.85);
  return rawScore;
}

// ── Crossover ─────────────────────────────────────────────────────────────────

function applyCrossover(base: PromptConfig, secondary: PromptConfig): PromptConfig {
  const config: PromptConfig = JSON.parse(JSON.stringify(base));
  const secondaryChars = secondary.characters ?? [];
  const chars = config.characters ?? [];
  if (chars.length >= 2 && secondaryChars.length >= 2) {
    config.characters = [chars[0], secondaryChars[1], ...chars.slice(2)];
  }
  config.name = `${base.name} x ${secondary.name}`;
  return config;
}

// ── Partial generation record ──────────────────────────────────────────────────

async function writePartialGen(
  jobId: string,
  genIndex: number,
  startedAt: string,
  variants: RatedConfig[],
): Promise<void> {
  if (variants.length === 0) return;
  const bestIdx = variants.reduce(
    (bi, v, i) => (getEffective(v) > getEffective(variants[bi]) ? i : bi),
    0,
  );
  const genPadded = String(genIndex).padStart(3, "0");
  const partial: GenerationRecord = { index: genIndex, startedAt, variants, eliteIndex: bestIdx };
  await writeFile(
    path.join(OPT_DIR, jobId, "generations", `gen-${genPadded}.json`),
    JSON.stringify(partial, null, 2),
  ).catch(() => {});
}

// ── Main job runner ────────────────────────────────────────────────────────────

export async function runOptimizationJob(jobId: string, signal?: AbortSignal): Promise<void> {
  try {
    await ensureJobDir(jobId);
    let job = await readState(jobId);

    while (job.currentGeneration <= job.maxGenerations && !job.stopFlag && !signal?.aborted) {
      const genIndex = job.currentGeneration;
      const genStarted = new Date().toISOString();

      const elite = getElite(job.population);
      const parentConfig = elite?.config ?? job.seedConfig;
      const secondBest = getSecondBest(job.population);

      const mutationPlan = getMutationPlan(job.variantsPerGeneration);
      const variantResults: RatedConfig[] = [];

      // Critique-guided mutation chain: each eval produces mutation text for the next variant
      let pendingMutText: string | null = null;
      let pendingMutField: MutationField | null = null;

      for (let vi = 0; vi < job.variantsPerGeneration; vi++) {
        try { job = await readState(jobId); } catch { /* use existing */ }
        if (job.stopFlag || signal?.aborted) break;

        const mutField = mutationPlan[vi];
        const nextField: MutationField =
          (mutationPlan[vi + 1] as MutationField | undefined) ?? mutationPlan[0];

        // ── CARRYOVER: reuse the elite instead of re-running it ───────────────
        // Only carryover if the elite has a real rating — null-rated elites should
        // be re-run so the seed always has a meaningful score to compare against.
        if (mutField === "seed" && elite !== null && elite.rating !== null) {
          emit(jobId, {
            type: "mutation_complete",
            jobId,
            generation: genIndex,
            variant: vi,
            mutationField: "seed",
            isCarryover: true,
          });

          // Bootstrap: use the elite's stored rating to generate the first mutation
          if (elite.rating && nextField !== "seed" && nextField !== "crossover") {
            const mutText = await generateMutationFromCritique(
              parentConfig,
              elite.rating,
              nextField,
              job.judgeModel,
              signal,
            );
            if (mutText) {
              pendingMutText = mutText;
              pendingMutField = nextField;
            }
          }

          const carryover: RatedConfig = {
            ...elite,
            isCarryover: true,
            generationIndex: genIndex,
            variantIndex: vi,
          };
          variantResults.push(carryover);
          job.population = updatePopulation(job.population, carryover);
          await writeState(job);
          await writePartialGen(jobId, genIndex, genStarted, variantResults);
          continue;
        }

        // ── BUILD MUTATED CONFIG ──────────────────────────────────────────────

        let mutatedConfig: PromptConfig;

        if (mutField === "seed") {
          // Use the parent config unmodified (seed variant — no elite existed to carryover)
          mutatedConfig = JSON.parse(JSON.stringify(parentConfig)) as PromptConfig;
        } else if (mutField === "crossover" && secondBest) {
          mutatedConfig = applyCrossover(parentConfig, secondBest.config);
        } else if (pendingMutText && pendingMutField === mutField) {
          mutatedConfig = applyTextMutation(parentConfig, mutField, pendingMutText);
        } else {
          throw new Error(
            `No mutation text available for field "${mutField}" (vi=${vi}, gen=${genIndex}). ` +
            `pendingMutText=${pendingMutText === null ? "null" : `wrong field (${pendingMutField})`}. ` +
            `The evaluate+mutate call likely failed — check num_predict / JSON parse errors.`,
          );
        }

        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          mutationField: mutField,
        });

        // ── RUN HEADLESS SIMULATION ───────────────────────────────────────────

        const runId = String(Date.now());

        // Apply character model override if set
        const configForRun: PromptConfig = job.characterModel
          ? {
              ...mutatedConfig,
              characters: (mutatedConfig.characters ?? []).map((c) => ({
                ...c,
                model: job.characterModel!,
              })),
            }
          : mutatedConfig;

        const { turns, terminationReason } = await runHeadless(
          configForRun,
          { maxTurns: job.maxTurnsPerRun, temperature: job.temperature, contextWindow: 12, signal },
          (turn) => {
            emit(jobId, { type: "turn_complete", jobId, generation: genIndex, variant: vi, turn });
          },
        );

        emit(jobId, {
          type: "run_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          runId,
          turnCount: turns.length,
        });

        // ── COMBINED EVALUATE + MUTATE ────────────────────────────────────────

        const { rating, mutatedText } = await evaluateAndMutate(
          mutatedConfig,
          turns,
          nextField,
          job.judgeModel,
          signal,
        );

        // Chain: store mutation text for the next variant in this generation
        if (mutatedText && nextField !== "seed" && nextField !== "crossover") {
          pendingMutText = mutatedText;
          pendingMutField = nextField;
        } else {
          pendingMutText = null;
          pendingMutField = null;
        }

        emit(jobId, {
          type: "rating_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          rating,
        });

        // ── EFFECTIVE SCORE ───────────────────────────────────────────────────
        // Null rating (evaluator failed) → -1 so these never become elite.

        const rawScore = rating !== null ? (rating?.total ?? 0) : -1;
        const effectiveScore = rating === null ? -1 : computeEffectiveScore(rawScore, turns.length, terminationReason);

        const ratedVariant: RatedConfig = {
          config: mutatedConfig,
          runId,
          turns,
          rating,
          turnCount: turns.length,
          generationIndex: genIndex,
          variantIndex: vi,
          mutationField: mutField,
          mutationQuality: "ok",
          parentConfigName: parentConfig.name,
          terminationReason,
          effectiveScore,
        };

        variantResults.push(ratedVariant);
        job.population = updatePopulation(job.population, ratedVariant);
        await writeState(job);
        await writePartialGen(jobId, genIndex, genStarted, variantResults);
      }

      // ── FIND GENERATION ELITE (non-carryover) ────────────────────────────────

      const genElite =
        variantResults
          .filter((v) => !v.isCarryover)
          .reduce<RatedConfig | null>((best, v) => {
            if (!best) return v;
            return getEffective(v) > getEffective(best) ? v : best;
          }, null) ?? variantResults[0];

      const eliteIndex = variantResults.indexOf(genElite);

      // ── HEAD-TO-HEAD COMPARISON ────────────────────────────────────────────
      // If the new gen elite claims a top position, verify against the all-time best.

      const allTimeBest = getElite(job.population);
      if (
        genElite &&
        !genElite.isCarryover &&
        allTimeBest &&
        genElite.runId !== allTimeBest.runId &&
        getEffective(genElite) >= getEffective(allTimeBest)
      ) {
        try {
          const winner = await compareTranscripts(
            genElite.turns,
            genElite.config.name,
            allTimeBest.turns,
            allTimeBest.config.name,
            job.judgeModel,
            signal,
          );
          // If the all-time best wins head-to-head, nudge challenger down so it doesn't displace
          if (winner === "b") {
            const idx = job.population.findIndex((v) => v.runId === genElite.runId);
            if (idx >= 0 && (job.population[idx].effectiveScore ?? 0) > 0) {
              job.population[idx] = {
                ...job.population[idx],
                effectiveScore: Math.max(0, (job.population[idx].effectiveScore ?? 0) - 1),
              };
            }
          }
          await writeState(job);
        } catch { /* non-critical */ }
      }

      // ── WRITE GENERATION RECORD ────────────────────────────────────────────

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
      await writeState(job);
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
    unregisterJob(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const job = await readState(jobId);
      job.status = signal?.aborted ? "stopped" : "error";
      job.lastError = signal?.aborted ? undefined : message;
      job.completedAt = new Date().toISOString();
      await writeState(job);
    } catch { /* best effort */ }
    if (!signal?.aborted) {
      emit(jobId, { type: "error", jobId, message });
    }
    cleanupJobBus(jobId);
    unregisterJob(jobId);
  }
}
