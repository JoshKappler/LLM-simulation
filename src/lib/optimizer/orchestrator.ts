/**
 * Orchestrator — manages the full optimization generation loop.
 *
 * Generation 0 runs the seed config ONCE to establish a rated baseline.
 * Subsequent generations follow a genetic algorithm cycle:
 *   1. MUTATION:  Generate N-1 variants from the elite's critique.
 *   2. RUN:       Execute all new variant conversations.
 *   3. EVALUATE:  Rate ALL transcripts using the judge model.
 *   4. SELECTION: Pick the winner, update population, advance generation.
 *
 * Variant 0 in gen 1+ is always the elite carryover (no re-run needed).
 * Variants 1..N-1 are mutations informed by the elite's critique.
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
  ConversationTurn,
} from "../types";
import { runHeadless } from "./executor";
import { rateTranscript, generateMutation, compareTranscripts } from "./evaluator";
import { emitJobEvent, cleanupJobBus } from "./eventBus";
import { unregisterJob } from "./jobRegistry";

const OPT_DIR = path.join(process.cwd(), "optimization");
const MIN_TURNS = 8;
const INTER_CALL_DELAY_MS = 2000; // Proactive delay between Groq calls (429 retry handled in llmClient)
const ERROR_RETRY_DELAY_MS = 10000; // Backoff before retrying a failed run
const CONSECUTIVE_FAIL_LIMIT = 3; // Abort after N consecutive all-fail generations
const EXPLORATION_RATE = 0.25; // Fraction of mutations based on seed instead of elite

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
  if (event.type !== "turn_token" && event.type !== "evaluator_token") {
    appendEvent(jobId, event).catch(() => {});
  }
}

function emitLive(jobId: string, event: OptimizationEvent): void {
  emitJobEvent(jobId, event);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Aborted")); return; }
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

// ── Apply characterModel override ──────────────────────────────────────────────

function applyCharacterModel(config: PromptConfig, characterModel?: string): PromptConfig {
  if (!characterModel) return config;
  return {
    ...config,
    characters: (config.characters ?? []).map((c) => {
      const { numPredict: _drop, ...rest } = c;
      return { ...rest, model: characterModel };
    }),
  };
}

// ── Run a single variant with retry ────────────────────────────────────────────

interface RunResult {
  turns: ConversationTurn[];
  terminationReason: string;
  errorMessage?: string;
  runId: string;
}

async function executeVariantRun(
  jobId: string,
  config: PromptConfig,
  job: OptimizationJob,
  genIndex: number,
  variantIndex: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const configForRun = applyCharacterModel(config, job.characterModel);
  const runId = String(Date.now());

  // Killer speaks every 5th message: first at turn 5, then every 5 after.
  const killerThreshold = 5;

  const doRun = () =>
    runHeadless(
      configForRun,
      {
        maxTurns: job.maxTurnsPerRun,
        temperature: job.temperature,
        contextWindow: 12,
        signal,
        killerFirstThreshold: killerThreshold,
        killerInterval: 4,
        onToken: (ai, name, tok) =>
          emitLive(jobId, {
            type: "turn_token",
            jobId,
            generation: genIndex,
            variant: variantIndex,
            agentIndex: ai,
            agentName: name,
            token: tok,
          }),
      },
      (turn) => {
        emit(jobId, {
          type: "turn_complete",
          jobId,
          generation: genIndex,
          variant: variantIndex,
          turn,
        });
      },
    );

  let result = await doRun();

  // Retry on error with backoff (handles transient rate limits)
  if (result.terminationReason === "error" && !signal?.aborted) {
    console.log(`[orchestrator] Run error (gen ${genIndex} var ${variantIndex}): ${result.errorMessage ?? "unknown"}, retrying after ${ERROR_RETRY_DELAY_MS}ms...`);
    await sleep(ERROR_RETRY_DELAY_MS, signal);
    result = await doRun();
  }

  // Retry short successful runs (not errors)
  if (
    result.turns.length < MIN_TURNS &&
    result.terminationReason !== "error" &&
    result.terminationReason !== "stopped" &&
    !signal?.aborted
  ) {
    console.log(`[orchestrator] Short run (${result.turns.length} turns, gen ${genIndex} var ${variantIndex}), retrying...`);
    await sleep(INTER_CALL_DELAY_MS, signal);
    result = await doRun();
  }

  emit(jobId, {
    type: "run_complete",
    jobId,
    generation: genIndex,
    variant: variantIndex,
    runId,
    turnCount: result.turns.length,
  });

  // Log run errors as events so the UI can display them
  if (result.terminationReason === "error") {
    emit(jobId, {
      type: "error",
      jobId,
      message: `Run failed (gen ${genIndex}, var ${variantIndex}): ${result.errorMessage ?? "unknown error"}`,
    });
  }

  return {
    turns: result.turns,
    terminationReason: result.terminationReason,
    errorMessage: result.errorMessage,
    runId,
  };
}

// ── Write generation record ────────────────────────────────────────────────────

async function writeGenRecord(
  jobId: string,
  genIndex: number,
  startedAt: string,
  variants: RatedConfig[],
  eliteIndex: number,
): Promise<void> {
  const genRecord: GenerationRecord = {
    index: genIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    variants,
    eliteIndex,
  };
  const genPadded = String(genIndex).padStart(3, "0");
  await writeFile(
    path.join(OPT_DIR, jobId, "generations", `gen-${genPadded}.json`),
    JSON.stringify(genRecord, null, 2),
  ).catch(() => {});
}

// ── Main job runner ────────────────────────────────────────────────────────────

export async function runOptimizationJob(jobId: string, signal?: AbortSignal): Promise<void> {
  try {
    await ensureJobDir(jobId);
    let job = await readState(jobId);
    let consecutiveFailedGens = 0;

    while (job.currentGeneration < job.maxGenerations && !stopped(job, signal)) {
      const genIndex = job.currentGeneration;
      const genStarted = new Date().toISOString();

      // ════════════════════════════════════════════════════════════════════════
      // GEN 0 — BASELINE: Run seed config once, evaluate, establish baseline
      // ════════════════════════════════════════════════════════════════════════

      if (genIndex === 0) {
        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: 0,
          variant: 0,
          mutationField: "seed",
        });

        // Run seed config
        emit(jobId, { type: "run_start", jobId, generation: 0, variant: 0 });
        const runResult = await executeVariantRun(jobId, job.seedConfig, job, 0, 0, signal);

        if (stopped(job, signal)) break;

        // Evaluate the baseline run
        await sleep(INTER_CALL_DELAY_MS, signal);

        let rating = null;
        if (runResult.terminationReason !== "error" && runResult.turns.length >= 2) {
          try {
            rating = await rateTranscript(
              job.seedConfig,
              runResult.turns,
              job.judgeModel,
              signal,
              (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "evaluate" }),
            );
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }

        const rawScore = rating !== null ? (rating.total ?? 0) : -1;
        const effectiveScore =
          rating === null ? -1 : computeEffectiveScore(rawScore, runResult.turns.length, runResult.terminationReason);

        const baseline: RatedConfig = {
          config: job.seedConfig,
          runId: runResult.runId,
          turns: runResult.turns,
          rating,
          turnCount: runResult.turns.length,
          generationIndex: 0,
          variantIndex: 0,
          mutationField: "seed",
          mutationQuality: "ok",
          parentConfigName: job.seedConfig.name,
          terminationReason: runResult.terminationReason,
          isCarryover: false,
          effectiveScore,
        };

        job.population = updatePopulation(job.population, baseline);

        emit(jobId, {
          type: "rating_complete",
          jobId,
          generation: 0,
          variant: 0,
          rating,
        });

        await writeGenRecord(jobId, 0, genStarted, [baseline], 0);

        emit(jobId, {
          type: "generation_complete",
          jobId,
          generation: 0,
          elite: rating
            ? { total: rating.total, summary: rating.summary, mutationField: "seed" }
            : undefined,
        });

        // Check stop after evaluation completes — prevents starting gen 1
        if (stopped(job, signal)) break;

        // Track failures
        if (runResult.terminationReason === "error") {
          consecutiveFailedGens++;
        } else {
          consecutiveFailedGens = 0;
        }

        if (consecutiveFailedGens >= CONSECUTIVE_FAIL_LIMIT) {
          job.status = "error";
          job.lastError = `Aborted: baseline run failed. ${runResult.errorMessage ?? "unknown error"}`;
          job.completedAt = new Date().toISOString();
          job.currentGeneration = 1;
          await writeState(job);
          emit(jobId, { type: "error", jobId, message: job.lastError });
          emit(jobId, { type: "job_complete", jobId });
          cleanupJobBus(jobId);
          unregisterJob(jobId);
          return;
        }

        job.currentGeneration = 1;
        await writeState(job);
        job = await readState(jobId);
        continue;
      }

      // ════════════════════════════════════════════════════════════════════════
      // GEN 1+ — EVOLUTION CYCLE
      // ════════════════════════════════════════════════════════════════════════

      const elite = getElite(job.population);
      const parentConfig = elite?.config ?? job.seedConfig;
      const critique = elite?.rating ?? null; // Mutations are INFORMED by this

      // ── Phase 1: MUTATION ──────────────────────────────────────────────────
      // Generate all variant configs. Variant 0 = elite carryover.
      // Variants 1..N-1 = mutations from elite + its critique.

      interface VariantSlot {
        config: PromptConfig;
        isCarryover: boolean;
        mutationField: MutationField;
      }

      const variantSlots: VariantSlot[] = [];

      // Variant 0: elite carryover (or seed if no rated elite)
      if (elite && elite.rating !== null) {
        variantSlots.push({ config: elite.config, isCarryover: true, mutationField: "seed" });
        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: genIndex,
          variant: 0,
          mutationField: "seed",
          isCarryover: true,
        });
      } else {
        variantSlots.push({
          config: JSON.parse(JSON.stringify(job.seedConfig)) as PromptConfig,
          isCarryover: false,
          mutationField: "seed",
        });
        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: genIndex,
          variant: 0,
          mutationField: "seed",
        });
      }

      // Variants 1..N-1: mutations informed by critique
      for (let vi = 1; vi < job.variantsPerGeneration; vi++) {
        if (stopped(job, signal)) break;

        await sleep(INTER_CALL_DELAY_MS, signal);

        const useExploration = job.variantsPerGeneration >= 3 && Math.random() < EXPLORATION_RATE;
        const mutationBase = useExploration ? job.seedConfig : parentConfig;

        let mutated: PromptConfig | null = null;
        try {
          mutated = await generateMutation(
            mutationBase,
            critique, // THIS is the key difference — always has critique from gen 0+
            job.mutationModel,
            signal,
            (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "mutate" }),
          );
        } catch (err) {
          if (signal?.aborted) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[orchestrator] Mutation failed (gen ${genIndex} var ${vi}): ${msg}`);
          emit(jobId, {
            type: "error",
            jobId,
            message: `Mutation failed (gen ${genIndex}, var ${vi}): ${msg}`,
          });
        }

        const resolvedField: MutationField = mutated ? "rewrite" : "parent_copy";
        variantSlots.push({
          config: mutated ?? (JSON.parse(JSON.stringify(mutationBase)) as PromptConfig),
          isCarryover: false,
          mutationField: resolvedField,
        });

        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          mutationField: resolvedField,
        });
      }

      if (stopped(job, signal)) break;

      // ── Phase 2: RUN ──────────────────────────────────────────────────────
      // Execute all variant conversations. Skip carryovers.

      const runSlots: (RunResult | null)[] = [];
      // Track partial results for incremental gen record writes
      const inProgressVariants: RatedConfig[] = [];

      for (let vi = 0; vi < variantSlots.length; vi++) {
        // Re-read state to check stop flag
        try { job = await readState(jobId); } catch { /* use existing */ }
        if (stopped(job, signal)) {
          runSlots.push(null);
          continue;
        }

        const slot = variantSlots[vi];

        // Carryover: reuse elite's stored turns — no re-run needed
        if (slot.isCarryover && elite) {
          runSlots.push({
            turns: elite.turns,
            terminationReason: elite.terminationReason ?? "max_turns",
            runId: elite.runId,
          });
          inProgressVariants.push({ ...elite, isCarryover: true, generationIndex: genIndex, variantIndex: vi });
          continue;
        }

        // Delay between runs to avoid rate limits
        if (runSlots.some((r) => r !== null)) {
          await sleep(INTER_CALL_DELAY_MS, signal);
        }

        emit(jobId, { type: "run_start", jobId, generation: genIndex, variant: vi });
        const runResult = await executeVariantRun(jobId, slot.config, job, genIndex, vi, signal);
        runSlots.push(runResult);

        // Write incremental gen record so drill-down shows each variant as it completes
        inProgressVariants.push({
          config: slot.config, runId: runResult.runId, turns: runResult.turns,
          rating: null, turnCount: runResult.turns.length, generationIndex: genIndex,
          variantIndex: vi, mutationField: slot.mutationField, mutationQuality: "ok",
          parentConfigName: parentConfig.name, terminationReason: runResult.terminationReason,
          isCarryover: false, effectiveScore: -1,
        });
        await writeGenRecord(jobId, genIndex, genStarted, inProgressVariants, 0);
      }

      if (stopped(job, signal)) break;

      // ── Phase 3: EVALUATE ─────────────────────────────────────────────────
      // Rate ALL transcripts using the judge model.

      const variantResults: RatedConfig[] = [];

      for (let vi = 0; vi < variantSlots.length; vi++) {
        if (stopped(job, signal)) break;

        const slot = variantSlots[vi];
        const run = runSlots[vi];
        if (!run) continue;

        // Carryover: use elite's stored rating
        if (slot.isCarryover && elite) {
          const carryover: RatedConfig = {
            ...elite,
            isCarryover: true,
            generationIndex: genIndex,
            variantIndex: vi,
          };
          variantResults.push(carryover);
          job.population = updatePopulation(job.population, carryover);
          await writeState(job);
          // Write incremental gen record so drill-down shows progress
          await writeGenRecord(jobId, genIndex, genStarted, variantResults, 0);
          continue;
        }

        // Delay between rating calls
        if (variantResults.length > 0) {
          await sleep(INTER_CALL_DELAY_MS, signal);
        }

        // Rate the transcript
        let rating = null;
        if (run.terminationReason !== "error" && run.turns.length >= 2) {
          try {
            rating = await rateTranscript(
              slot.config,
              run.turns,
              job.judgeModel,
              signal,
              (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "evaluate" }),
            );
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }

        const rawScore = rating !== null ? (rating.total ?? 0) : -1;
        const effectiveScore =
          rating === null ? -1 : computeEffectiveScore(rawScore, run.turns.length, run.terminationReason);

        const ratedVariant: RatedConfig = {
          config: slot.config,
          runId: run.runId,
          turns: run.turns,
          rating,
          turnCount: run.turns.length,
          generationIndex: genIndex,
          variantIndex: vi,
          mutationField: slot.mutationField,
          mutationQuality: "ok",
          parentConfigName: parentConfig.name,
          terminationReason: run.terminationReason,
          isCarryover: false,
          effectiveScore,
        };

        variantResults.push(ratedVariant);
        job.population = updatePopulation(job.population, ratedVariant);
        await writeState(job);

        // Write incremental gen record so drill-down shows progress
        const currentBestIdx = variantResults.reduce(
          (bi, v, i) => (getEffective(v) > getEffective(variantResults[bi]) ? i : bi), 0,
        );
        await writeGenRecord(jobId, genIndex, genStarted, variantResults, currentBestIdx);

        emit(jobId, {
          type: "rating_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          rating,
        });
      }

      // ── Phase 4: SELECTION ────────────────────────────────────────────────

      // Check if all variants failed
      const allFailed = variantResults.length === 0 || variantResults.every(
        (v) => v.terminationReason === "error" || v.effectiveScore === -1,
      );

      if (allFailed) {
        consecutiveFailedGens++;
      } else {
        consecutiveFailedGens = 0;
      }

      // Write generation record even on failure
      const eliteIndex = variantResults.length > 0
        ? variantResults.reduce(
            (bi, v, i) => (getEffective(v) > getEffective(variantResults[bi]) ? i : bi),
            0,
          )
        : 0;

      await writeGenRecord(jobId, genIndex, genStarted, variantResults, eliteIndex);

      const genElite = variantResults[eliteIndex] ?? null;

      // Head-to-head comparison when a new variant claims top
      const allTimeBest = getElite(job.population);
      if (
        genElite &&
        !genElite.isCarryover &&
        allTimeBest &&
        genElite.runId !== allTimeBest.runId &&
        getEffective(genElite) > getEffective(allTimeBest)
      ) {
        try {
          await sleep(INTER_CALL_DELAY_MS, signal);
          const winner = await compareTranscripts(
            genElite.turns,
            genElite.config.name,
            allTimeBest.turns,
            allTimeBest.config.name,
            job.judgeModel,
            signal,
          );
          if (winner === "b") {
            const idx = job.population.findIndex((v) => v.runId === genElite.runId);
            if (idx >= 0) {
              job.population[idx] = {
                ...job.population[idx],
                effectiveScore: Math.max(0, getEffective(allTimeBest) - 1),
              };
            }
          }
          await writeState(job);
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }

      emit(jobId, {
        type: "generation_complete",
        jobId,
        generation: genIndex,
        elite: genElite?.rating
          ? {
              total: genElite.rating.total,
              summary: genElite.rating.summary,
              mutationField: genElite.mutationField,
            }
          : undefined,
      });

      job.currentGeneration++;
      await writeState(job);

      // Abort on catastrophic failure
      if (consecutiveFailedGens >= CONSECUTIVE_FAIL_LIMIT) {
        const lastError = variantResults.find((v) => v.terminationReason === "error");
        job.status = "error";
        job.lastError = `Aborted: ${consecutiveFailedGens} consecutive generations all failed. Check API key and model availability.`;
        job.completedAt = new Date().toISOString();
        await writeState(job);
        emit(jobId, { type: "error", jobId, message: job.lastError });
        emit(jobId, { type: "job_complete", jobId });
        cleanupJobBus(jobId);
        unregisterJob(jobId);
        return;
      }

      // Re-read state for next iteration (picks up external stop flag changes)
      job = await readState(jobId);
    }

    // ── Job finished normally ─────────────────────────────────────────────────
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
    } catch { /* best effort */ }
    if (!signal?.aborted) {
      emit(jobId, { type: "error", jobId, message });
    }
    emit(jobId, { type: "job_complete", jobId });
    cleanupJobBus(jobId);
    unregisterJob(jobId);
  }
}
