/**
 * Orchestrator — manages the full optimization generation loop.
 *
 * Generation 0 runs the seed config ONCE, audits+rates it, then generates
 * targeted fixes (stored in pendingRewrites for gen 1).
 *
 * Subsequent generations:
 *   1. BUILD VARIANTS:  Slots 0..K = pendingRewrites (targeted fixes from
 *      previous gen's audit). Remaining = exploration mutations. NO carryover
 *      slot — the elite's existing score is used for comparison directly.
 *   2. RUN:  Execute all variant conversations (only new variants, never re-run elite).
 *   3. RATE:  For each variant, audit+rate the transcript.
 *   4. FIX:  For each rated variant, generate targeted fixes for top violations.
 *   5. SELECTION:  Compare new variants against elite's stored score, update population.
 *      If elite wins again, generate new targeted fixes from ITS audit.
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
  AuditResult,
} from "../types";
import { runHeadless } from "./executor";
import { auditAndRate, generateTargetedFix, generateExploreMutation, compareTranscripts } from "./evaluator";
import { emitJobEvent, cleanupJobBus } from "./eventBus";
import { unregisterJob } from "./jobRegistry";

const OPT_DIR = path.join(process.cwd(), "optimization");
const MIN_TURNS = 8;
const INTER_CALL_DELAY_MS = 2000; // Proactive delay between Groq calls (429 retry handled in llmClient)
const ERROR_RETRY_DELAY_MS = 10000; // Backoff before retrying a failed run
const CONSECUTIVE_FAIL_LIMIT = 3; // Abort after N consecutive all-fail generations
const MAX_HISTORY_ENTRIES = 8; // How many past mutations to include in history

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
      return { ...c, model: characterModel };
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

  const killerThreshold = 0;

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

// ── Mutation history ────────────────────────────────────────────────────────────

function computeChangeDescription(variant: PromptConfig, parent: PromptConfig): string {
  const changes: string[] = [];
  if ((variant.situation ?? "") !== (parent.situation ?? "")) changes.push("situation rewritten");
  if ((variant.guidelines ?? "") !== (parent.guidelines ?? "")) changes.push("guidelines changed");
  const vc = variant.characters ?? [];
  const pc = parent.characters ?? [];
  for (let i = 0; i < Math.max(vc.length, pc.length); i++) {
    if ((vc[i]?.systemPrompt ?? "") !== (pc[i]?.systemPrompt ?? "")) {
      const name = vc[i]?.name ?? pc[i]?.name ?? `char ${i}`;
      const role = vc[i]?.role ?? pc[i]?.role;
      changes.push(`${name}${role === "killer" ? " (killer)" : ""} prompt changed`);
    }
  }
  return changes.length > 0 ? changes.join(", ") : "no changes detected";
}

function buildMutationHistory(population: RatedConfig[], currentEliteRunId?: string): string {
  const entries = population
    .filter((v) => v.runId !== currentEliteRunId && v.rating !== null && !v.isCarryover)
    .sort((a, b) => (b.effectiveScore ?? 0) - (a.effectiveScore ?? 0))
    .slice(0, MAX_HISTORY_ENTRIES);

  if (entries.length === 0) return "";

  return entries
    .map((e) => {
      const strategy = e.mutationField === "explore" ? "explore" : e.mutationField === "targeted_fix" ? "targeted-fix" : e.mutationField === "rewrite" ? "transcript-rewrite" : "refine";
      const score = e.effectiveScore ?? e.rating?.total ?? 0;
      const desc = e.changeDescription ?? "unknown changes";
      let weakDims = "";
      if (e.rating) {
        const dims = [
          { name: "emotionalAuth", score: e.rating.emotionalAuthenticity.score, notes: e.rating.emotionalAuthenticity.notes },
          { name: "naturalDialogue", score: e.rating.naturalDialogue.score, notes: e.rating.naturalDialogue.notes },
          { name: "tensionArc", score: e.rating.dramaticTensionArc.score, notes: e.rating.dramaticTensionArc.notes },
          { name: "coherence", score: e.rating.scenarioCoherence.score, notes: e.rating.scenarioCoherence.notes },
          { name: "resolution", score: e.rating.organicResolution.score, notes: e.rating.organicResolution.notes },
        ];
        dims.sort((a, b) => a.score - b.score);
        const top2 = dims.slice(0, 2);
        weakDims = ` weak: ${top2.map((d) => `${d.name}=${d.score} ("${d.notes.slice(0, 80)}")`).join(", ")}`;
      }
      const summary = e.rating?.summary ? ` | "${e.rating.summary.slice(0, 120)}..."` : "";
      return `- Gen ${e.generationIndex} (${strategy}, score ${score}/50): ${desc}.${weakDims}${summary}`;
    })
    .join("\n");
}

// ── Main job runner ────────────────────────────────────────────────────────────

function buildTranscriptExcerpt(turns: ConversationTurn[], maxTurns = 10): string {
  const filtered = turns.filter((t) => !t.isStreaming && t.content.trim());
  if (filtered.length === 0) return "";

  if (filtered.length <= maxTurns) {
    return filtered
      .map((t) => {
        const wc = t.content.trim().split(/\s+/).length;
        return `[${t.agentName}] (${wc} words): ${t.content}`;
      })
      .join("\n");
  }

  const longestSlots = Math.ceil(maxTurns / 2);
  const contextSlots = maxTurns - longestSlots;

  const byLength = filtered
    .map((t, i) => ({ i, wc: t.content.trim().split(/\s+/).length }))
    .sort((a, b) => b.wc - a.wc);
  const longestIndices = new Set(byLength.slice(0, longestSlots).map((x) => x.i));

  const step = Math.max(1, Math.floor(filtered.length / (contextSlots + 1)));
  for (let i = 0; i < filtered.length && longestIndices.size < maxTurns; i += step) {
    longestIndices.add(i);
  }

  const selectedIndices = Array.from(longestIndices).sort((a, b) => a - b).slice(0, maxTurns);

  return selectedIndices
    .map((i) => {
      const t = filtered[i];
      const wc = t.content.trim().split(/\s+/).length;
      return `[${t.agentName}] (${wc} words): ${t.content}`;
    })
    .join("\n");
}

/** Generate targeted fixes from an audit, returning up to maxFixes configs */
async function generateFixesFromAudit(
  config: PromptConfig,
  audit: AuditResult,
  maxFixes: number,
  model: string,
  jobId: string,
  signal?: AbortSignal,
  mutationHistory?: string,
): Promise<PromptConfig[]> {
  const fixes: PromptConfig[] = [];
  // Only target prompt-fixable violations, sorted by severity
  const severityOrder = { critical: 0, moderate: 1, minor: 2 };
  const targetable = audit.violations
    .map((v, i) => ({ v, i }))
    .sort((a, b) => severityOrder[a.v.severity] - severityOrder[b.v.severity]);

  for (let fi = 0; fi < Math.min(targetable.length, maxFixes); fi++) {
    if (signal?.aborted) break;
    await sleep(INTER_CALL_DELAY_MS, signal);
    try {
      const fix = await generateTargetedFix(
        config,
        audit,
        targetable[fi].i,
        model,
        signal,
        (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "mutate" }),
        mutationHistory,
      );
      if (fix) fixes.push(fix);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[orchestrator] Targeted fix ${fi} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return fixes;
}

export async function runOptimizationJob(jobId: string, signal?: AbortSignal): Promise<void> {
  try {
    await ensureJobDir(jobId);
    let job = await readState(jobId);
    let consecutiveFailedGens = 0;

    while (job.currentGeneration < job.maxGenerations && !stopped(job, signal)) {
      const genIndex = job.currentGeneration;
      const genStarted = new Date().toISOString();
      const characterModel = job.characterModel ?? job.seedConfig.characters?.[0]?.model ?? "unknown";

      // ════════════════════════════════════════════════════════════════════════
      // GEN 0 — BASELINE: Run seed config once, audit+rate, generate targeted fixes
      // ════════════════════════════════════════════════════════════════════════

      if (genIndex === 0) {
        await writeGenRecord(jobId, 0, genStarted, [], 0);

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

        // Audit + Rate baseline transcript
        await sleep(INTER_CALL_DELAY_MS, signal);

        let audit: AuditResult | null = null;
        const pendingFixes: PromptConfig[] = [];

        if (runResult.terminationReason !== "error" && runResult.turns.length >= 2) {
          try {
            audit = await auditAndRate(
              runResult.turns,
              job.seedConfig,
              job.judgeModel,
              characterModel,
              signal,
              (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "evaluate" }),
            );
          } catch (err) {
            if (signal?.aborted) throw err;
          }

          // Generate targeted fixes for top violations
          if (audit && audit.violations.length > 0 && !stopped(job, signal)) {
            const maxFixes = Math.ceil(job.variantsPerGeneration / 2);
            const fixes = await generateFixesFromAudit(
              job.seedConfig, audit, maxFixes, job.mutationModel, jobId, signal,
            );
            pendingFixes.push(...fixes);
          }
        }

        job.pendingRewrites = pendingFixes;

        const rating = audit?.rating ?? null;
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
          audit: audit ?? undefined,
        };

        job.population = updatePopulation(job.population, baseline);

        emit(jobId, {
          type: "rating_complete",
          jobId,
          generation: 0,
          variant: 0,
          rating,
        });

        await writeGenRecord(jobId, 0, genStarted, [baseline], 0, true);

        emit(jobId, {
          type: "generation_complete",
          jobId,
          generation: 0,
          elite: rating
            ? { total: rating.total, summary: rating.summary, mutationField: "seed" }
            : undefined,
        });

        if (stopped(job, signal)) break;

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
      // No carryover slot. Elite's stored score competes as-is.
      // Only genuinely new variants consume resources.
      // ════════════════════════════════════════════════════════════════════════

      const elite = getElite(job.population);
      const parentConfig = elite?.config ?? job.seedConfig;
      const critique = elite?.rating ?? null;

      // ── Phase 1: BUILD VARIANTS ──────────────────────────────────────────
      // Slots 0..K = pendingRewrites (targeted fixes from previous gen).
      // Slots K+1..N-1 = exploration mutations (creative leaps).
      // NO carryover slot.

      interface VariantSlot {
        config: PromptConfig;
        mutationField: MutationField;
      }

      await writeGenRecord(jobId, genIndex, genStarted, [], 0);

      const variantSlots: VariantSlot[] = [];
      const mutationHistoryStr = buildMutationHistory(job.population, elite?.runId);

      // Fill from pendingRewrites (targeted fixes from previous gen's audit)
      const maxRewriteSlots = Math.ceil(job.variantsPerGeneration / 2);
      const rawRewrites = job.pendingRewrites ?? [];

      const validRewrites = rawRewrites.filter((rw) => {
        const desc = computeChangeDescription(rw, parentConfig);
        return desc !== "no changes detected";
      });
      const rewriteSlots = Math.min(validRewrites.length, maxRewriteSlots, job.variantsPerGeneration);

      for (let ri = 0; ri < rewriteSlots; ri++) {
        const vi = variantSlots.length;
        variantSlots.push({
          config: validRewrites[ri],
          mutationField: "targeted_fix",
        });
        emit(jobId, {
          type: "mutation_complete",
          jobId,
          generation: genIndex,
          variant: vi,
          mutationField: "targeted_fix",
        });
      }

      // Fill remaining slots with exploration mutations
      const eliteTranscriptExcerpt = elite?.turns ? buildTranscriptExcerpt(elite.turns) : undefined;

      for (let vi = variantSlots.length; vi < job.variantsPerGeneration; vi++) {
        if (stopped(job, signal)) break;

        await sleep(INTER_CALL_DELAY_MS, signal);

        let mutated: PromptConfig | null = null;
        try {
          mutated = await generateExploreMutation(
            parentConfig,
            critique,
            job.mutationModel,
            signal,
            (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "mutate" }),
            mutationHistoryStr || undefined,
            eliteTranscriptExcerpt || undefined,
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

        const resolvedField: MutationField = mutated ? "explore" : "parent_copy";
        if (!mutated) {
          console.warn(`[orchestrator] Explore mutation returned null (gen ${genIndex} var ${vi}) — falling back to parent copy`);
          emit(jobId, {
            type: "error",
            jobId,
            message: `Explore mutation failed (gen ${genIndex}, var ${vi}): model output could not be parsed — using parent copy instead.`,
          });
        }
        variantSlots.push({
          config: mutated ?? (JSON.parse(JSON.stringify(parentConfig)) as PromptConfig),
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
      // Execute all variant conversations. All are new — no carryover.

      const runSlots: (RunResult | null)[] = [];
      const inProgressVariants: RatedConfig[] = [];

      for (let vi = 0; vi < variantSlots.length; vi++) {
        try { job = await readState(jobId); } catch { /* use existing */ }
        if (stopped(job, signal)) {
          runSlots.push(null);
          continue;
        }

        // Delay between runs
        if (runSlots.some((r) => r !== null)) {
          await sleep(INTER_CALL_DELAY_MS, signal);
        }

        emit(jobId, { type: "run_start", jobId, generation: genIndex, variant: vi });
        const runResult = await executeVariantRun(jobId, variantSlots[vi].config, job, genIndex, vi, signal);
        runSlots.push(runResult);

        inProgressVariants.push({
          config: variantSlots[vi].config, runId: runResult.runId, turns: runResult.turns,
          rating: null, turnCount: runResult.turns.length, generationIndex: genIndex,
          variantIndex: vi, mutationField: variantSlots[vi].mutationField, mutationQuality: "ok",
          parentConfigName: parentConfig.name, terminationReason: runResult.terminationReason,
          isCarryover: false, effectiveScore: -1,
        });
        await writeGenRecord(jobId, genIndex, genStarted, inProgressVariants, 0);
      }

      if (stopped(job, signal)) break;

      // ── Phase 3: AUDIT + RATE ─────────────────────────────────────────────
      // For each variant, audit+rate the transcript.
      // Collect targeted fixes for next generation.

      const variantResults: RatedConfig[] = [];
      const nextGenRewrites: PromptConfig[] = [];
      let bestNewVariant: RatedConfig | null = null;
      let bestNewAudit: AuditResult | null = null;

      for (let vi = 0; vi < variantSlots.length; vi++) {
        if (stopped(job, signal)) break;

        const slot = variantSlots[vi];
        const run = runSlots[vi];
        if (!run) continue;

        // Delay between calls
        if (variantResults.length > 0) {
          await sleep(INTER_CALL_DELAY_MS, signal);
        }

        // Audit + Rate (combined pass)
        let audit: AuditResult | null = null;
        if (run.terminationReason !== "error" && run.turns.length >= 2) {
          try {
            audit = await auditAndRate(
              run.turns,
              slot.config,
              job.judgeModel,
              characterModel,
              signal,
              (token) => emitLive(jobId, { type: "evaluator_token", jobId, token, phase: "evaluate" }),
            );
          } catch (err) {
            if (signal?.aborted) throw err;
            console.warn(`[orchestrator] Audit failed (gen ${genIndex} var ${vi}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const rating = audit?.rating ?? null;
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
          changeDescription: computeChangeDescription(slot.config, parentConfig),
          audit: audit ?? undefined,
        };

        variantResults.push(ratedVariant);
        job.population = updatePopulation(job.population, ratedVariant);
        await writeState(job);

        // Track best new variant + its audit for fix generation
        if (!bestNewVariant || getEffective(ratedVariant) > getEffective(bestNewVariant)) {
          bestNewVariant = ratedVariant;
          bestNewAudit = audit;
        }

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

      // ── Phase 4: SELECTION + FIX GENERATION ─────────────────────────────

      const allFailed = variantResults.length === 0 || variantResults.every(
        (v) => v.terminationReason === "error" || v.effectiveScore === -1,
      );

      if (allFailed) {
        consecutiveFailedGens++;
      } else {
        consecutiveFailedGens = 0;
      }

      // Determine generation winner (among new variants only)
      const genEliteIndex = variantResults.length > 0
        ? variantResults.reduce(
            (bi, v, i) => (getEffective(v) > getEffective(variantResults[bi]) ? i : bi),
            0,
          )
        : 0;

      const genWinner = variantResults[genEliteIndex] ?? null;

      // Compare best new variant against all-time elite
      const allTimeBest = getElite(job.population);
      let eliteWon = false;

      if (
        genWinner &&
        allTimeBest &&
        genWinner.runId !== allTimeBest.runId &&
        getEffective(genWinner) > getEffective(allTimeBest)
      ) {
        // New variant claims top — head-to-head comparison
        try {
          await sleep(INTER_CALL_DELAY_MS, signal);
          const winner = await compareTranscripts(
            genWinner.turns,
            genWinner.config.name,
            allTimeBest.turns,
            allTimeBest.config.name,
            job.judgeModel,
            signal,
          );
          if (winner === "b") {
            // Elite defended — demote new variant
            const idx = job.population.findIndex((v) => v.runId === genWinner.runId);
            if (idx >= 0) {
              job.population[idx] = {
                ...job.population[idx],
                effectiveScore: Math.max(0, getEffective(allTimeBest) - 1),
              };
            }
            eliteWon = true;
          }
          await writeState(job);
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      } else if (allTimeBest && genWinner && getEffective(genWinner) <= getEffective(allTimeBest)) {
        // Elite's stored score beat all new variants outright
        eliteWon = true;
      }

      // Generate targeted fixes for next generation
      // If elite won again, generate fixes from the elite's audit (if available)
      // Otherwise, generate fixes from the best new variant's audit
      if (!stopped(job, signal) && !allFailed) {
        const fixSource = eliteWon && allTimeBest?.audit
          ? { config: allTimeBest.config, audit: allTimeBest.audit }
          : bestNewAudit
            ? { config: bestNewVariant!.config, audit: bestNewAudit }
            : null;

        if (fixSource && fixSource.audit.violations.length > 0) {
          const maxFixes = Math.ceil(job.variantsPerGeneration / 2);
          const fixes = await generateFixesFromAudit(
            fixSource.config, fixSource.audit, maxFixes,
            job.mutationModel, jobId, signal, mutationHistoryStr || undefined,
          );
          nextGenRewrites.push(...fixes);
        }
      }

      job.pendingRewrites = nextGenRewrites;

      await writeGenRecord(jobId, genIndex, genStarted, variantResults, genEliteIndex, true);

      emit(jobId, {
        type: "generation_complete",
        jobId,
        generation: genIndex,
        elite: genWinner?.rating
          ? {
              total: genWinner.rating.total,
              summary: genWinner.rating.summary,
              mutationField: genWinner.mutationField,
            }
          : undefined,
      });

      job.currentGeneration++;
      await writeState(job);

      // Abort on catastrophic failure
      if (consecutiveFailedGens >= CONSECUTIVE_FAIL_LIMIT) {
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

      // Re-read state for next iteration
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
