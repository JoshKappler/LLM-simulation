/**
 * Combined evaluator — rates a transcript AND generates a critique-guided
 * mutation for a target field in one LLM call. Replaces the separate
 * judge + mutator two-call pattern.
 */

import type { ConversationTurn, PromptConfig, RatingResult, MutationField } from "../types";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

// ── Field rules (injected into mutation prompts) ───────────────────────────────

const FIELD_RULES: Record<string, string> = {
  situation: `RULES FOR SITUATION:
- Describe physical reality: what the room looks, sounds, smells like. Put characters IN the space.
- Explain the mechanic clearly: what must happen, what the timer/consequence is, what choices exist.
- Include survival logic: what happens if they refuse, what happens if they comply.
- Do NOT include character direction (e.g. "you are brave", "your first instinct is").
- Do NOT include format rules.
- Characters should not know each other before the scenario begins.`,

  character: `RULES FOR CHARACTER PROMPTS:
- Describe who this person IS right now: name, age, occupation, personality, how fear manifests.
- Describe what they value and what they stand to lose.
- Do NOT explain the mechanic, timer, or rules — that belongs in the situation.
- Do NOT give tactical instructions ("pick one concrete thing", "argue directly").
- Leave room for the character to concede, beg, break down, or fight — all are valid.
- No lines like "your first instinct is to survive" — just describe who they are.`,

  killer: `RULES FOR KILLER CHARACTER:
- Preserve the core mechanic rules (timer, agreement requirement, kills both if no agreement).
- You may change tone, verbosity, intimidation style, and pacing of countdown reminders.
- Keep the RESOLVED trigger logic: killer outputs RESOLVED after the survivor reacts.
- Keep the primer-style opener where the killer explains the rules plainly.
- Do NOT add warmth or sympathy — the killer is indifferent to both characters.
- Do NOT remove or fundamentally change the endgame logic.`,

  guidelines: `RULES FOR GUIDELINES:
- Format rules only: sentence limits, no asterisks, no stage directions, no internal thoughts.
- Do NOT add situation-specific logic here (e.g. "you will not agree to die").
- Do NOT add character psychology or backstory.
- Keep it short and format-focused.`,
};

function getFieldRules(field: MutationField): string {
  if (field === "situation") return FIELD_RULES.situation;
  if (field === "character_0" || field === "character_1") return FIELD_RULES.character;
  if (field === "character_killer") return FIELD_RULES.killer;
  if (field === "guidelines") return FIELD_RULES.guidelines;
  return "";
}

function getFieldLabel(field: MutationField): string {
  if (field === "situation") return "Situation";
  if (field === "character_0") return "Character A";
  if (field === "character_1") return "Character B";
  if (field === "character_killer") return "Killer Character";
  if (field === "guidelines") return "Guidelines";
  return field;
}

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildCurrentPrompts(config: PromptConfig): string {
  const parts: string[] = [];
  parts.push(`Situation:\n${config.situation ?? "(none)"}`);
  for (const char of config.characters ?? []) {
    const label =
      char.role === "killer"
        ? `Killer (${char.name})`
        : char.name;
    parts.push(`${label}:\n${char.systemPrompt ?? "(none)"}`);
  }
  if (config.guidelines) parts.push(`Guidelines:\n${config.guidelines}`);
  return parts.join("\n\n");
}

function buildTranscript(turns: ConversationTurn[]): string {
  return turns
    .filter((t) => !t.isStreaming && t.content.trim())
    .map((t, i) => `[TURN ${i + 1} — ${t.agentName}]: ${t.content}`)
    .join("\n");
}

function buildEvaluateAndMutatePrompt(
  config: PromptConfig,
  turns: ConversationTurn[],
  targetField: MutationField,
): string {
  const transcript = buildTranscript(turns);
  const prompts = buildCurrentPrompts(config);
  const fieldLabel = getFieldLabel(targetField);
  const fieldRules = getFieldRules(targetField);
  const includesMutation = targetField !== "seed" && targetField !== "crossover";

  const mutationTask = includesMutation
    ? `
STEP 2 — MUTATE: Rewrite the "${fieldLabel}" field to address the weakest dimension above. Use the critique notes as your guide.

${fieldRules}

The new text must be meaningfully different from the original — not just rephrased.`
    : "";

  const mutationOutput = includesMutation
    ? `,\n  "mutatedText": "... new ${fieldLabel} text ..."`
    : "";

  return `You are a drama critic and prompt engineer evaluating a roleplay transcript.

CURRENT PROMPTS:
${prompts}

TRANSCRIPT:
${transcript}

STEP 1 — RATE this transcript on 5 dimensions (0–10 integers each):
- emotionalAuthenticity: Do the characters sound genuinely scared or desperate? Penalize theatrical bravado or calm acceptance.
- naturalDialogue: Do they speak like real people under pressure? Penalize debate-style argument or clinical language.
- dramaticTensionArc: Does the conversation escalate with meaningful beats? Penalize flat exchanges or instant resolution.
- scenarioCoherence: Do characters stay grounded in the physical situation? Penalize invented backstory or ignoring the mechanic.
- organicResolution: Does it end naturally? Penalize abrupt RESOLVED without setup, or circular stalemates.
${mutationTask}

Return ONLY valid JSON (no markdown, no preamble):
{
  "rating": {
    "emotionalAuthenticity": { "score": 0, "notes": "..." },
    "naturalDialogue": { "score": 0, "notes": "..." },
    "dramaticTensionArc": { "score": 0, "notes": "..." },
    "scenarioCoherence": { "score": 0, "notes": "..." },
    "organicResolution": { "score": 0, "notes": "..." },
    "total": 0,
    "summary": "...",
    "flags": []
  }${mutationOutput}
}

flags must only contain labels from: ["name-chanting", "backstory-dump", "philosophical-detachment", "robotic-compliance", "invented-relationship", "debate-strategy"]`;
}

function buildMutationFromCritiquePrompt(
  config: PromptConfig,
  existingRating: RatingResult,
  targetField: MutationField,
): string {
  const prompts = buildCurrentPrompts(config);
  const fieldLabel = getFieldLabel(targetField);
  const fieldRules = getFieldRules(targetField);

  const weaknesses = (
    ["emotionalAuthenticity", "naturalDialogue", "dramaticTensionArc", "scenarioCoherence", "organicResolution"] as const
  )
    .map((k) => `- ${k}: ${existingRating[k].score}/10 — ${existingRating[k].notes}`)
    .join("\n");

  return `You are a prompt engineer improving a roleplay scenario. Use this critique to rewrite one field.

CRITIQUE OF THE CURRENT BEST RUN:
${weaknesses}
Summary: ${existingRating.summary}
${existingRating.flags.length > 0 ? `Flags: ${existingRating.flags.join(", ")}` : ""}

CURRENT PROMPTS:
${prompts}

TASK: Rewrite the "${fieldLabel}" field to address the weakest dimensions above.

${fieldRules}

The new text must be meaningfully different from the current version.
Return ONLY the new ${fieldLabel} text, no preamble, no explanation.`;
}

// ── Ollama call ────────────────────────────────────────────────────────────────

async function callModel(model: string, prompt: string, jsonMode: boolean, signal?: AbortSignal): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    think: false,
    options: {
      temperature: jsonMode ? 0.3 : 0.85,
      num_predict: jsonMode ? 3000 : 1200,
    },
  };
  if (jsonMode) body.format = "json";

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Evaluator model ${res.status}: ${await res.text().catch(() => "(no body)")}`);
  }

  const data = await res.json();
  return (data?.message?.content ?? "").trim();
}

// ── Response parsing ──────────────────────────────────────────────────────────

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

function tryParseEvalResponse(raw: string): { rating: RatingResult; mutatedText: string | undefined } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed.rating) return null;
    const rating = parseRating(parsed.rating as Record<string, unknown>);
    const mutatedText: string | undefined =
      typeof parsed.mutatedText === "string" && parsed.mutatedText.trim()
        ? parsed.mutatedText.trim()
        : undefined;
    return { rating, mutatedText };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Rate a transcript AND generate a critique-guided mutation for targetField,
 * all in a single LLM call.
 *
 * For seed/crossover variants, mutatedText will be undefined (rating only).
 */
export async function evaluateAndMutate(
  config: PromptConfig,
  turns: ConversationTurn[],
  targetField: MutationField,
  model: string,
  signal?: AbortSignal,
): Promise<{ rating: RatingResult | null; mutatedText: string | undefined }> {
  if (turns.filter((t) => !t.isStreaming).length < 2) {
    return { rating: null, mutatedText: undefined };
  }

  const prompt = buildEvaluateAndMutatePrompt(config, turns, targetField);

  try {
    const raw = await callModel(model, prompt, true, signal);
    const result = tryParseEvalResponse(raw);
    if (result) return result;

    // Retry
    const raw2 = await callModel(model, prompt + "\n\nIMPORTANT: Return ONLY the JSON object.", true, signal);
    return tryParseEvalResponse(raw2) ?? { rating: null, mutatedText: undefined };
  } catch {
    return { rating: null, mutatedText: undefined };
  }
}

/**
 * Generate a critique-guided mutation for targetField using an existing rating
 * (no transcript needed — used for the carryover/elite bootstrap case).
 */
export async function generateMutationFromCritique(
  config: PromptConfig,
  existingRating: RatingResult,
  targetField: MutationField,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (targetField === "seed" || targetField === "crossover") return null;

  const prompt = buildMutationFromCritiquePrompt(config, existingRating, targetField);

  try {
    const text = await callModel(model, prompt, false, signal);
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Apply a text mutation to the appropriate field of a config.
 */
export function applyTextMutation(
  base: PromptConfig,
  field: MutationField,
  text: string,
): PromptConfig {
  const config: PromptConfig = JSON.parse(JSON.stringify(base));
  const chars = config.characters ?? [];

  if (field === "situation") {
    config.situation = text;
  } else if (field === "character_0" && chars[0]) {
    config.characters = [...chars];
    config.characters[0] = { ...chars[0], systemPrompt: text };
  } else if (field === "character_1" && chars[1]) {
    config.characters = [...chars];
    config.characters[1] = { ...chars[1], systemPrompt: text };
  } else if (field === "character_killer") {
    config.characters = [...chars];
    const killerIdx = config.characters.findIndex((c) => c.role === "killer");
    if (killerIdx >= 0) {
      config.characters[killerIdx] = { ...config.characters[killerIdx], systemPrompt: text };
    }
  } else if (field === "guidelines") {
    config.guidelines = text;
  }

  config.name = `${base.name} [${field}]`;
  return config;
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
    const raw = await callModel(model, prompt, false, signal);
    return raw.trim().toUpperCase().startsWith("A") ? "a" : "b";
  } catch {
    return "a"; // default to keeping current best on error
  }
}
