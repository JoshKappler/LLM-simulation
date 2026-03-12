/**
 * Evaluator — rates transcripts and generates complete prompt rewrites.
 *
 * The primary flow is analyzeAndRewrite: the LLM watches the transcript,
 * diagnoses what in the prompting caused weaknesses, then rewrites all
 * fields from scratch (situation, characters, guidelines). This replaces
 * the old field-by-field mutation approach.
 */

import type { ConversationTurn, PromptConfig, RatingResult } from "../types";
import { streamLLM } from "../llmClient";

// ── Shared rules injected into rewrite prompts ─────────────────────────────────

const REWRITE_RULES = `RULES FOR SITUATION:
- Describe physical reality: what the room looks, sounds, smells like. Put characters IN the space.
- Explain the mechanic clearly: what must happen, what the timer/consequence is, what choices exist.
- Include survival logic: what happens if they refuse, what happens if they comply.
- Characters should not know each other before the scenario begins.
- Do NOT include character direction or format rules.

RULES FOR CHARACTER DESCRIPTIONS:
- Describe who this person IS right now: personality, how fear manifests, what they value and stand to lose.
- Do NOT explain the mechanic or timer — that belongs in the situation.
- Do NOT give tactical instructions. Leave room for the character to concede, beg, break down, or fight.
- No survival-instinct lines ("your first instinct is to survive"). Just describe who they are.

RULES FOR GUIDELINES:
- Format rules only: sentence limits, no asterisks, no stage directions, no internal thoughts.
- Keep it short. Do NOT add situation-specific logic or character psychology here.

RULES FOR KILLER DESCRIPTION:
- The killer controls the scenario mechanic. Their prompt must make the RESOLVED output clear and simple.
- Killer should output RESOLVED on its own line when the scenario ends (agreement reached or timer expires).
- Keep killer instructions concise — complex multi-step sequences fail with smaller models.
- Do NOT change the killer's primer — only the systemPrompt is rewritten.

KNOWN FAILURE MODES (never produce prompts that trigger these):
- Tactical character prompts ("make your case", "pick one concrete thing", "push back") → characters debate strategy instead of experiencing fear
- Mechanic or timer description in character prompts → characters go tactical from line 1 instead of reacting emotionally
- Vague or abstract situation text → characters treat it as background, not physical reality they're trapped in
- Overly specific emotional prescription ("you feel desperate, you are terrified") → models perform emotion rather than embody it
- Survival-instinct framing in character prompts → produces robotic self-preservation monologue
- Duplicating mechanic explanation in both situation AND character prompts → models think procedurally from line 1
- Overly complex killer instructions → killer never outputs RESOLVED, run never terminates`;

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildCurrentPrompts(config: PromptConfig): string {
  const parts: string[] = [];
  parts.push(`Situation:\n${config.situation ?? "(none)"}`);
  for (const char of config.characters ?? []) {
    const label = char.role === "killer" ? `Killer (${char.name})` : char.name;
    parts.push(`${label}:\n${char.systemPrompt ?? "(none)"}`);
  }
  if (config.guidelines) parts.push(`Guidelines:\n${config.guidelines}`);
  return parts.join("\n\n");
}

const MAX_TRANSCRIPT_TURNS = 20;

function buildTranscript(turns: ConversationTurn[], maxTurns = MAX_TRANSCRIPT_TURNS): string {
  const filtered = turns.filter((t) => !t.isStreaming && t.content.trim());
  const limited = filtered.length > maxTurns ? filtered.slice(-maxTurns) : filtered;
  return limited.map((t, i) => `[TURN ${i + 1} — ${t.agentName}]: ${t.content}`).join("\n");
}

function buildCharacterNames(config: PromptConfig): string {
  return (config.characters ?? [])
    .map((c) => `"${c.name}"`)
    .join(", ");
}

function buildCharEntries(config: PromptConfig): string {
  return (config.characters ?? [])
    .map((c) => {
      const comment = c.role === "killer" ? " /* killer — keep RESOLVED output simple */" : "";
      return `    {"name": "${c.name}", "systemPrompt": "... completely new description ..."}${comment}`;
    })
    .join(",\n");
}

function buildFullRewriteSchema(config: PromptConfig): string {
  return `{
  "rating": {
    "emotionalAuthenticity": {"score": 0, "notes": "..."},
    "naturalDialogue": {"score": 0, "notes": "..."},
    "dramaticTensionArc": {"score": 0, "notes": "..."},
    "scenarioCoherence": {"score": 0, "notes": "..."},
    "organicResolution": {"score": 0, "notes": "..."},
    "summary": "...",
    "flags": []
  },
  "situation": "... completely new situation ...",
  "characters": [
${buildCharEntries(config)}
  ],
  "guidelines": "... new guidelines ..."
}`;
}

function buildPromptsOnlySchema(config: PromptConfig): string {
  return `{
  "situation": "... completely new situation ...",
  "characters": [
${buildCharEntries(config)}
  ],
  "guidelines": "... new guidelines ..."
}`;
}

function buildAnalyzeAndRewritePrompt(
  config: PromptConfig,
  turns: ConversationTurn[],
  eliteConfig?: PromptConfig,
  eliteScore?: number,
): string {
  const transcript = buildTranscript(turns);
  const charNames = buildCharacterNames(eliteConfig ?? config);
  const schema = buildFullRewriteSchema(eliteConfig ?? config);

  const hasElite = eliteConfig && eliteScore !== undefined;
  const elitePrompts = hasElite ? buildCurrentPrompts(eliteConfig!) : null;
  const currentPrompts = buildCurrentPrompts(config);

  const promptsSection = hasElite
    ? `BEST PERFORMING PROMPTS (score: ${eliteScore}/50 — use as your baseline):
${elitePrompts}

TEST RUN PROMPTS (what was running when this transcript was produced):
${currentPrompts}`
    : `CURRENT PROMPTS:
${currentPrompts}`;

  const calibration = hasElite
    ? `\nCalibration: the best run so far scored ${eliteScore}/50. If this run scored similarly, make small targeted changes. If this run scored significantly lower, more substantial rethinking is warranted — but always start from the BEST PERFORMING PROMPTS, not from scratch.\n`
    : "";

  return `You are a drama critic and prompt engineer. A roleplay scenario ran and produced the transcript below. Your job is to understand what went wrong and improve the prompts.

${promptsSection}

TRANSCRIPT:
${transcript}

STEP 1 — RATE the transcript (0–10 integers each):
- emotionalAuthenticity: Do characters sound genuinely scared or desperate? Penalize theatrical bravado, detachment, or calm acceptance.
- naturalDialogue: Do they speak like real people under pressure? Penalize debate-style argument, bullet reasoning, or clinical language.
- dramaticTensionArc: Does the conversation escalate with meaningful beats? Penalize flat exchanges or instant resolution.
- scenarioCoherence: Do characters stay grounded in the physical situation? Penalize invented backstory or ignoring the mechanic.
- organicResolution: Does it end naturally (agreement, breakdown, or unresolved)? Penalize abrupt RESOLVED without setup, or circular stalemates.

Score each dimension independently based on what you actually observed. A typical roleplay run scores between 3 and 8 on each dimension. Reserve 0 for transcripts that are completely empty or unintelligible.
${calibration}
STEP 2 — DIAGNOSE: Identify the 2–3 most underwhelming moments in the transcript. For each, trace it back to something specific in the prompts that likely caused it.

STEP 3 — IMPROVE: Starting from the BEST PERFORMING PROMPTS${hasElite ? "" : " (the current prompts)"}, make targeted improvements based on your diagnosis. Only change the fields responsible for the specific problems you identified. If a field is not contributing to the weaknesses, preserve its core content. Every change must be justified by a specific observation. Preserve character names (${charNames}).

${REWRITE_RULES}

Return ONLY valid JSON (no markdown, no preamble):
${schema}

flags must only contain labels from: ["name-chanting", "backstory-dump", "philosophical-detachment", "robotic-compliance", "invented-relationship", "debate-strategy"]`;
}

function buildRewriteFromCritiquePrompt(config: PromptConfig, rating: RatingResult): string {
  const prompts = buildCurrentPrompts(config);
  const charNames = buildCharacterNames(config);

  const critique = (
    ["emotionalAuthenticity", "naturalDialogue", "dramaticTensionArc", "scenarioCoherence", "organicResolution"] as const
  )
    .map((k) => `- ${k}: ${rating[k].score}/10 — ${rating[k].notes}`)
    .join("\n");

  return `You are a prompt engineer. Here is a critique of the current best roleplay scenario run:

CRITIQUE:
${critique}
Summary: ${rating.summary}
${rating.flags.length > 0 ? `Flags: ${rating.flags.join(", ")}` : ""}

CURRENT BEST PROMPTS (score: ${rating.total}/50):
${prompts}

Based on the critique above, make targeted improvements to these prompts. Only change the fields that are causing the identified problems. Preserve what is already working. Every change must address a specific issue in the critique. Preserve character names (${charNames}).

${REWRITE_RULES}

Return ONLY valid JSON (no markdown):
${buildPromptsOnlySchema(config)}`;
}

// ── LLM call ───────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS = 120_000; // 2-minute hard timeout per LLM call

async function callModel(model: string, prompt: string, jsonMode: boolean, signal?: AbortSignal, onToken?: (token: string) => void, temperatureOverride?: number): Promise<string> {
  if (signal?.aborted) throw Object.assign(new Error("AbortError"), { name: "AbortError" });

  // Combine job abort signal with a per-call timeout so a hanging Groq request
  // doesn't block the orchestrator indefinitely.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error("LLM call timed out")), CALL_TIMEOUT_MS);

  // If the job abort signal fires, forward it to the timeout controller so the
  // stream aborts immediately. This replaces AbortSignal.any for compatibility.
  const onJobAbort = () => timeoutController.abort(signal!.reason ?? new Error("Job aborted"));
  if (signal && !signal.aborted) {
    signal.addEventListener("abort", onJobAbort, { once: true });
  } else if (signal?.aborted) {
    throw Object.assign(new Error("AbortError"), { name: "AbortError" });
  }
  const combined = timeoutController.signal;

  let fullContent = "";
  try {
    for await (const chunk of streamLLM({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: temperatureOverride ?? (jsonMode ? 0.4 : 0.9),
      maxTokens: jsonMode ? 5000 : 2000,
      // Omit response_format — Groq's json_object mode with streaming can hang for
      // certain model/prompt combos. The prompts already explicitly request JSON output.
      signal: combined,
    })) {
      fullContent += chunk;
      onToken?.(chunk);
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onJobAbort);
  }
  let output = fullContent.trim();
  // Strip think blocks that reasoning models (e.g. deepseek-r1, qwen-qwq) prepend before JSON
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Strip markdown code fences
  output = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  return output;
}

// ── Response parsing ───────────────────────────────────────────────────────────

/** Extract the first JSON object/array from a string that may have leading prose. */
function extractJsonString(raw: string): string {
  if (raw.startsWith("{") || raw.startsWith("[")) return raw;
  const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return match ? match[1] : raw;
}

function parseRating(parsed: Record<string, unknown>): RatingResult {
  const dim = (key: string) => {
    const d = parsed[key] as Record<string, unknown> | undefined;
    return {
      score: Math.min(10, Math.max(0, Number(d?.score ?? 0))),
      notes: String(d?.notes ?? ""),
    };
  };
  const r: RatingResult = {
    emotionalAuthenticity: dim("emotionalAuthenticity"),
    naturalDialogue: dim("naturalDialogue"),
    dramaticTensionArc: dim("dramaticTensionArc"),
    scenarioCoherence: dim("scenarioCoherence"),
    organicResolution: dim("organicResolution"),
    summary: String(parsed.summary ?? ""),
    flags: Array.isArray(parsed.flags) ? (parsed.flags as unknown[]).map(String) : [],
    total: 0,
  };
  r.total =
    r.emotionalAuthenticity.score +
    r.naturalDialogue.score +
    r.dramaticTensionArc.score +
    r.scenarioCoherence.score +
    r.organicResolution.score;
  return r;
}

function applyNewPromptsToConfig(
  base: PromptConfig,
  parsed: Record<string, unknown>,
): PromptConfig {
  const config: PromptConfig = JSON.parse(JSON.stringify(base));

  if (typeof parsed.situation === "string" && parsed.situation.trim()) {
    config.situation = parsed.situation.trim();
  }
  if (typeof parsed.guidelines === "string" && parsed.guidelines.trim()) {
    config.guidelines = parsed.guidelines.trim();
  }

  if (Array.isArray(parsed.characters)) {
    const newChars = parsed.characters as { name?: string; systemPrompt?: string }[];
    // Match by index — all characters (including killer) are now included in the schema
    newChars.forEach((nc, ni) => {
      const existing = config.characters?.[ni];
      if (!existing) return;
      if (typeof nc.systemPrompt === "string" && nc.systemPrompt.trim()) {
        // Preserve everything except systemPrompt (primer, model, numPredict, role all stay)
        config.characters![ni] = { ...existing, systemPrompt: nc.systemPrompt.trim() };
      }
    });
  }

  config.name = `${base.name} [rewrite]`;
  return config;
}

function tryParseRewriteResponse(
  raw: string,
  base: PromptConfig,
): { rating: RatingResult; newConfig: PromptConfig } | null {
  try {
    const parsed = JSON.parse(extractJsonString(raw)) as Record<string, unknown>;
    if (!parsed.rating || !parsed.situation) return null;
    const rating = parseRating(parsed.rating as Record<string, unknown>);
    // Detect template echo: model returned schema example without filling it in
    const allZero = (
      [rating.emotionalAuthenticity, rating.naturalDialogue, rating.dramaticTensionArc, rating.scenarioCoherence, rating.organicResolution] as { score: number; notes: string }[]
    ).every((d) => d.score === 0 && (!d.notes || d.notes === "..."));
    if (allZero) return null;
    const newConfig = applyNewPromptsToConfig(base, parsed);
    return { rating, newConfig };
  } catch {
    return null;
  }
}

function tryParsePromptsOnly(raw: string, base: PromptConfig): PromptConfig | null {
  try {
    const parsed = JSON.parse(extractJsonString(raw)) as Record<string, unknown>;
    if (!parsed.situation) return null;
    return applyNewPromptsToConfig(base, parsed);
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Rate a transcript AND generate an improved set of prompts in one LLM call.
 * The LLM diagnoses what in the prompting caused weaknesses, then makes targeted
 * improvements — starting from eliteConfig (if provided) as the baseline, not from scratch.
 */
export async function analyzeAndRewrite(
  config: PromptConfig,
  turns: ConversationTurn[],
  model: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
  eliteConfig?: PromptConfig,
  eliteScore?: number,
): Promise<{ rating: RatingResult | null; newConfig: PromptConfig | null }> {
  if (turns.filter((t) => !t.isStreaming).length < 2) {
    return { rating: null, newConfig: null };
  }

  const baseConfig = eliteConfig ?? config;
  const prompt = buildAnalyzeAndRewritePrompt(config, turns, eliteConfig, eliteScore);

  try {
    const raw = await callModel(model, prompt, true, signal, onToken);
    const result = tryParseRewriteResponse(raw, baseConfig);
    if (result) return result;

    // Retry
    const raw2 = await callModel(
      model,
      prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No text before or after.",
      true,
      signal,
      onToken,
    );
    return tryParseRewriteResponse(raw2, baseConfig) ?? { rating: null, newConfig: null };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { rating: null, newConfig: null };
  }
}

/**
 * Generate a complete prompt rewrite from an existing rating critique, without a transcript.
 * Used to bootstrap the first rewrite in a generation when the seed is carried over.
 */
export async function generateCompleteRewrite(
  config: PromptConfig,
  rating: RatingResult,
  model: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
): Promise<PromptConfig | null> {
  const prompt = buildRewriteFromCritiquePrompt(config, rating);

  try {
    const raw = await callModel(model, prompt, true, signal, onToken);
    return tryParsePromptsOnly(raw, config);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/**
 * Direct head-to-head transcript comparison. Returns "a" if A is better, "b" if B is better.
 */
export async function compareTranscripts(
  turnsA: ConversationTurn[],
  labelA: string,
  turnsB: ConversationTurn[],
  labelB: string,
  model: string,
  signal?: AbortSignal,
): Promise<"a" | "b"> {
  const tA = buildTranscript(turnsA);
  const tB = buildTranscript(turnsB);

  const prompt = `You are comparing two roleplay transcripts from the same scenario. Judge which demonstrates better dramatic quality overall — more authentic fear, natural dialogue, tension, and a satisfying arc.

TRANSCRIPT A (${labelA}):
${tA}

TRANSCRIPT B (${labelB}):
${tB}

Which transcript is dramatically superior? Reply with only the letter A or B.`;

  try {
    // Low temperature for deterministic comparison verdicts
    const raw = await callModel(model, prompt, false, signal, undefined, 0.1);
    return raw.trim().toUpperCase().startsWith("A") ? "a" : "b";
  } catch (err) {
    if (signal?.aborted) throw err;
    return "a"; // default to keeping current best on error
  }
}

// ── Separated rating & mutation (for restructured orchestrator) ─────────────

/**
 * Rate a transcript WITHOUT generating a rewrite.
 * Used in the evaluation phase after all runs complete.
 */
export async function rateTranscript(
  config: PromptConfig,
  turns: ConversationTurn[],
  model: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
): Promise<RatingResult | null> {
  if (turns.filter((t) => !t.isStreaming).length < 2) return null;

  const transcript = buildTranscript(turns);
  const prompts = buildCurrentPrompts(config);

  const prompt = `You are a drama critic. Rate this roleplay transcript on 5 dimensions.

PROMPTS THAT PRODUCED THIS TRANSCRIPT:
${prompts}

TRANSCRIPT:
${transcript}

Rate each dimension independently (0–10 integers):
- emotionalAuthenticity: Do characters sound genuinely scared or desperate? Penalize theatrical bravado, detachment, or calm acceptance.
- naturalDialogue: Do they speak like real people under pressure? Penalize debate-style argument, bullet reasoning, or clinical language.
- dramaticTensionArc: Does the conversation escalate with meaningful beats? Penalize flat exchanges or instant resolution.
- scenarioCoherence: Do characters stay grounded in the physical situation? Penalize invented backstory or ignoring the mechanic.
- organicResolution: Does it end naturally (agreement, breakdown, or unresolved)? Penalize abrupt RESOLVED without setup, or circular stalemates.

A typical roleplay run scores between 3 and 8 on each dimension. Reserve 0 for transcripts that are completely empty or unintelligible.

Return ONLY valid JSON (no markdown, no preamble):
{
  "emotionalAuthenticity": {"score": 0, "notes": "..."},
  "naturalDialogue": {"score": 0, "notes": "..."},
  "dramaticTensionArc": {"score": 0, "notes": "..."},
  "scenarioCoherence": {"score": 0, "notes": "..."},
  "organicResolution": {"score": 0, "notes": "..."},
  "summary": "...",
  "flags": []
}

flags must only contain labels from: ["name-chanting", "backstory-dump", "philosophical-detachment", "robotic-compliance", "invented-relationship", "debate-strategy"]`;

  try {
    const raw = await callModel(model, prompt, true, signal, onToken);
    const parsed = JSON.parse(extractJsonString(raw)) as Record<string, unknown>;
    const rating = parseRating(parsed);
    // Detect template echo
    const allZero = (
      [rating.emotionalAuthenticity, rating.naturalDialogue, rating.dramaticTensionArc, rating.scenarioCoherence, rating.organicResolution] as { score: number; notes: string }[]
    ).every((d) => d.score === 0 && (!d.notes || d.notes === "..."));
    if (allZero) return null;
    return rating;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/**
 * Generate a single prompt mutation from a parent config.
 * Uses the mutation model (separate from the judge model).
 * If a critique is provided, mutations target the weakest dimensions.
 */
export async function generateMutation(
  parentConfig: PromptConfig,
  critique: RatingResult | null,
  model: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
): Promise<PromptConfig | null> {
  const prompts = buildCurrentPrompts(parentConfig);
  const charNames = buildCharacterNames(parentConfig);

  let critiqueSection: string;
  if (critique) {
    const dims = (
      ["emotionalAuthenticity", "naturalDialogue", "dramaticTensionArc", "scenarioCoherence", "organicResolution"] as const
    )
      .map((k) => `- ${k}: ${critique[k].score}/10 — ${critique[k].notes}`)
      .join("\n");
    critiqueSection = `PERFORMANCE CRITIQUE (score: ${critique.total}/50):
${dims}
Summary: ${critique.summary}
${critique.flags.length > 0 ? `Flags: ${critique.flags.join(", ")}` : ""}

Focus your changes on the weakest dimensions. Make targeted, meaningful improvements.`;
  } else {
    critiqueSection = `This is an initial exploration round with no performance data yet. Create a distinct variation that takes the scenario in an interesting direction while maintaining the core premise and tone.`;
  }

  const schema = buildPromptsOnlySchema(parentConfig);

  const prompt = `You are a prompt engineer evolving roleplay scenarios through a genetic algorithm. Your job is to create ONE creative variation of the current prompts.

CURRENT PROMPTS:
${prompts}

${critiqueSection}

${REWRITE_RULES}

Preserve character names (${charNames}). Preserve character roles (character/killer).
Do NOT return identical prompts — every variant must differ meaningfully from the parent.

Return ONLY valid JSON (no markdown, no preamble):
${schema}`;

  try {
    const raw = await callModel(model, prompt, true, signal, onToken, 0.8);
    const result = tryParsePromptsOnly(raw, parentConfig);
    if (result) return result;

    // Retry once with a stricter instruction if parse failed
    const raw2 = await callModel(
      model,
      prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No markdown, no text before or after.",
      true,
      signal,
      onToken,
      0.8,
    );
    return tryParsePromptsOnly(raw2, parentConfig);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
