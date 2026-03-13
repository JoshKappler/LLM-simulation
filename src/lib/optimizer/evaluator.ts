/**
 * Evaluator — audits prompts + rates transcripts in a single pass, then
 * generates targeted fixes for specific violations.
 *
 * Pass 1 (auditAndRate): A judge model sees BOTH the prompts AND the
 * transcript. It checks prompt compliance, rates the transcript on 5
 * dimensions, and traces output problems back to specific prompt text.
 *
 * Pass 2 (generateTargetedFix): A mutation model receives ONE specific
 * violation to fix, plus causal evidence. It does NOT see the full
 * transcript — the audit already extracted what matters.
 *
 * Explore mutations (generateExploreMutation) remain a separate creative pass
 * with higher temperature and different prompt philosophy.
 */

import type { ConversationTurn, PromptConfig, RatingResult, AuditResult, PromptViolation, CausalDiagnosis } from "../types";
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
- Brevity is enforced automatically at runtime — do NOT add sentence-count limits or "keep it short" instructions in character prompts.

RULES FOR GUIDELINES:
- Format rules only: sentence limits, no asterisks, no stage directions, no internal thoughts.
- Keep it short. Do NOT add situation-specific logic or character psychology here.

RULES FOR PRIMERS:
- A primer is the character's very first spoken line — a short, in-character opening.
- Keep primers to 1-2 sentences maximum. They set emotional tone, not plot.
- Primers should match the character's emotional state and voice. No mechanic explanation in primers.
- Killer primers should establish menace/authority immediately.

RULES FOR KILLER DESCRIPTION:
- The killer controls the scenario mechanic. Their prompt must make the RESOLVED output clear and simple.
- Killer should output RESOLVED on its own line when the scenario ends (agreement reached or timer expires).
- The killer is ALSO a character — give them personality, menace, psychological texture. But keep the RESOLVED trigger logic clear.

KNOWN FAILURE MODES (never produce prompts that trigger these):
- Tactical character prompts ("make your case", "pick one concrete thing", "push back") → characters debate strategy instead of experiencing fear
- Mechanic or timer description in character prompts → characters go tactical from line 1 instead of reacting emotionally
- Vague or abstract situation text → characters treat it as background, not physical reality they're trapped in
- Overly specific emotional prescription ("you feel desperate, you are terrified") → models perform emotion rather than embody it
- Survival-instinct framing in character prompts → produces robotic self-preservation monologue
- Duplicating mechanic explanation in both situation AND character prompts → models think procedurally from line 1
- Overly complex killer instructions → killer never outputs RESOLVED, run never terminates
- The word RESOLVED appearing in any field except killer systemPrompt → characters treat it as dialogue or in-world concept`;

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildCurrentPrompts(config: PromptConfig): string {
  const parts: string[] = [];
  parts.push(`Situation:\n${config.situation ?? "(none)"}`);
  for (const char of config.characters ?? []) {
    const label = char.role === "killer" ? `Killer (${char.name})` : char.name;
    parts.push(`${label}:\n${char.systemPrompt ?? "(none)"}`);
    if (char.primer) parts.push(`  Primer: "${char.primer}"`);
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
      return `    {"name": "${c.name}", "systemPrompt": "... completely new description ...", "primer": "... short in-character opening line ..."}${comment}`;
    })
    .join(",\n");
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

// ── LLM call ───────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS = 120_000; // 2-minute hard timeout per LLM call

async function callModel(model: string, prompt: string, jsonMode: boolean, signal?: AbortSignal, onToken?: (token: string) => void, temperatureOverride?: number): Promise<string> {
  if (signal?.aborted) throw Object.assign(new Error("AbortError"), { name: "AbortError" });

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error("LLM call timed out")), CALL_TIMEOUT_MS);

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
      maxTokens: jsonMode ? 4000 : 2000,
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
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  output = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  return output;
}

// ── Response parsing ───────────────────────────────────────────────────────────

function extractJsonString(raw: string): string {
  if (raw.startsWith("{") || raw.startsWith("[")) return raw;
  const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return match ? match[1] : raw;
}

function parseRating(parsed: Record<string, unknown>): RatingResult {
  const dim = (key: string) => {
    const d = parsed[key] as Record<string, unknown> | undefined;
    const raw = Number(d?.score ?? 0);
    return {
      score: Math.min(10, Math.max(0, isNaN(raw) ? 0 : raw)),
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
    diagnosis: String(parsed.diagnosis ?? ""),
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

function isTemplateEcho(rating: RatingResult): boolean {
  return (
    [rating.emotionalAuthenticity, rating.naturalDialogue, rating.dramaticTensionArc, rating.scenarioCoherence, rating.organicResolution] as { score: number; notes: string }[]
  ).every((d) => d.score === 0 && (!d.notes || d.notes === "..."));
}

function parseViolations(raw: unknown[]): PromptViolation[] {
  return raw.map((v) => {
    const obj = v as Record<string, unknown>;
    return {
      field: String(obj.field ?? "unknown"),
      characterName: obj.characterName ? String(obj.characterName) : undefined,
      violation: String(obj.violation ?? ""),
      quotedText: String(obj.quotedText ?? ""),
      severity: (["minor", "moderate", "critical"].includes(String(obj.severity)) ? String(obj.severity) : "moderate") as PromptViolation["severity"],
    };
  });
}

function parseDiagnoses(raw: unknown[]): CausalDiagnosis[] {
  return raw.map((d) => {
    const obj = d as Record<string, unknown>;
    return {
      promptQuote: String(obj.promptQuote ?? ""),
      transcriptQuote: String(obj.transcriptQuote ?? ""),
      explanation: String(obj.explanation ?? ""),
      promptFixable: obj.promptFixable !== false,
    };
  });
}

function applyNewPromptsToConfig(
  base: PromptConfig,
  parsed: Record<string, unknown>,
): PromptConfig {
  const config: PromptConfig = JSON.parse(JSON.stringify(base));

  if (typeof parsed.situation === "string" && parsed.situation.trim()) {
    config.situation = parsed.situation.trim();
  } else if (parsed.situation !== undefined) {
    console.warn("[evaluator] Mutation returned empty/invalid situation — keeping original");
  }

  if (typeof parsed.guidelines === "string" && parsed.guidelines.trim()) {
    config.guidelines = parsed.guidelines.trim();
  } else if (parsed.guidelines !== undefined && parsed.guidelines !== null) {
    console.warn("[evaluator] Mutation returned empty/invalid guidelines — keeping original");
  }

  if (Array.isArray(parsed.characters)) {
    const newChars = parsed.characters as { name?: string; systemPrompt?: string; primer?: string }[];
    let appliedCount = 0;
    newChars.forEach((nc, ni) => {
      const existing = config.characters?.[ni];
      if (!existing) return;
      if (typeof nc.systemPrompt === "string" && nc.systemPrompt.trim()) {
        const updates: Record<string, string> = { systemPrompt: nc.systemPrompt.trim() };
        if (typeof nc.primer === "string" && nc.primer.trim()) {
          updates.primer = nc.primer.trim();
        }
        config.characters![ni] = { ...existing, ...updates };
        appliedCount++;
      } else {
        console.warn(`[evaluator] Mutation returned empty/invalid systemPrompt for character ${ni} (${existing.name}) — keeping original`);
      }
    });
    if (appliedCount === 0) {
      console.warn("[evaluator] Mutation returned characters array but no valid systemPrompts — all characters unchanged");
    }
  } else if (parsed.characters !== undefined) {
    console.warn("[evaluator] Mutation returned non-array characters field — keeping originals");
  }

  // Strip RESOLVED from non-killer fields to prevent keyword leaks
  if (config.situation) config.situation = config.situation.replace(/\bRESOLVED\b/gi, "");
  if (config.guidelines) config.guidelines = config.guidelines.replace(/\bRESOLVED\b/gi, "");
  for (const char of config.characters ?? []) {
    if (char.role !== "killer") {
      if (char.systemPrompt) char.systemPrompt = char.systemPrompt.replace(/\bRESOLVED\b/gi, "");
      if (char.primer) char.primer = char.primer.replace(/\bRESOLVED\b/gi, "");
    }
  }

  config.name = `${base.name} [rewrite]`;
  return config;
}

function tryParsePromptsOnly(raw: string, base: PromptConfig): PromptConfig | null {
  try {
    const parsed = JSON.parse(extractJsonString(raw)) as Record<string, unknown>;
    if (!parsed.situation) {
      console.warn(`[evaluator] Mutation parse failed: no 'situation' field. Raw (first 300 chars): ${raw.slice(0, 300)}`);
      return null;
    }
    if (Array.isArray(parsed.characters)) {
      const chars = parsed.characters as { systemPrompt?: string }[];
      const hasValidPrompt = chars.some((c) => typeof c.systemPrompt === "string" && c.systemPrompt.trim());
      if (!hasValidPrompt) {
        console.warn(`[evaluator] Mutation parse failed: characters array has no valid systemPrompts. Raw (first 300 chars): ${raw.slice(0, 300)}`);
        return null;
      }
    } else {
      console.warn(`[evaluator] Mutation parse warning: no characters array. Only situation/guidelines will update.`);
    }
    return applyNewPromptsToConfig(base, parsed);
  } catch (err) {
    console.warn(`[evaluator] Mutation JSON parse failed: ${err instanceof Error ? err.message : String(err)}. Raw (first 300 chars): ${raw.slice(0, 300)}`);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Combined audit + rating pass. The judge sees BOTH prompts AND transcript.
 *
 * 1. Prompt compliance audit — checks each field against REWRITE_RULES
 * 2. Transcript rating — existing 5-dimension scoring (unchanged, well-calibrated)
 * 3. Causal diagnosis — "this prompt line → this output problem"
 */
export async function auditAndRate(
  turns: ConversationTurn[],
  config: PromptConfig,
  model: string,
  characterModel: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
): Promise<AuditResult | null> {
  if (turns.filter((t) => !t.isStreaming).length < 2) return null;

  const transcript = buildTranscript(turns);
  const prompts = buildCurrentPrompts(config);

  const prompt = `You are an expert prompt engineer auditing a roleplay scenario. You will check the prompts for rule violations, rate the transcript, and trace output problems back to specific prompt text.

MODEL NOTE: Character dialogue was generated by ${characterModel}. When diagnosing output problems, distinguish between PROMPT-FIXABLE issues (bad prompt text caused bad output) and MODEL-CEILING issues (the model simply can't do better regardless of prompt). Mark each diagnosis accordingly.

PROMPT RULES:
${REWRITE_RULES}

CURRENT PROMPTS:
${prompts}

TRANSCRIPT:
${transcript}

STEP 1 — PROMPT COMPLIANCE AUDIT:
Check each prompt field against the rules above. For each violation found:
- Identify the field (situation, character name, guidelines, primer)
- Quote the specific violating text
- Explain which rule it breaks
- Rate severity: "minor", "moderate", or "critical"

STEP 2 — TRANSCRIPT RATING (0–10 integers each). You MUST quote specific lines to justify any score of 7+.

CALIBRATION: Most AI roleplay scores 3-6 per dimension. 20-30/50 is typical. 35+ is genuinely good. 40+ is exceptional. 45+ is almost never seen.

- emotionalAuthenticity: 1-2: Announce emotions without demonstrating them. 3-4: Standard AI fear — correct vocabulary, wrong register. MOST AI OUTPUT LANDS HERE. 5-6: Some genuine affect mixed with performative stretches. 7-8: Sustained authenticity — fear in HOW they speak, not WHAT they say. 9-10: Forget you're reading AI.
- naturalDialogue: 1-2: Essay monologues. 3-4: Clearly AI — too articulate under duress, balanced turn lengths. MOST AI OUTPUT LIVES HERE. 5-6: Occasionally human but rhythm too neat. 7-8: Real stress patterns — fragments, non-sequiturs, panic repetition. 9-10: Indistinguishable from real speech.
  IMPORTANT: Count the WORDS in each turn. Real humans under extreme stress speak in fragments of 5-20 words. If turns average 50+ words, naturalDialogue cannot score above 4. If turns average 100+ words, it's a 1-2 regardless of content quality.
- dramaticTensionArc: 1-2: Flat. 3-4: Predictable escalation, no reversals. STANDARD AI PACING. 5-6: Some tension but trajectory obvious early. 7-8: Genuinely uncertain outcome, real reversals. 9-10: Multiple recontextualizing reversals.
- scenarioCoherence: 1-2: Abstract discussion. 3-4: Backdrop awareness only. TYPICAL AI. 5-6: Scenario constrains behavior. 7-8: Physical space interaction. 9-10: Panic-driven sensory hyperawareness.
- organicResolution: 1-2: Abrupt/looping. 3-4: Forced capitulation or timeout. 5-6: Functional but arbitrary. 7-8: Earned from accumulated choices. 9-10: Reveals character, recontextualizes exchange.

STEP 3 — CAUSAL DIAGNOSIS:
For the 2-3 worst output problems in the transcript, trace each back to specific prompt text. For each:
- Quote the prompt text that caused it
- Quote the transcript line(s) that demonstrate the problem
- Explain the causal link
- Set promptFixable: true if changing the prompt would fix it, false if it's a model limitation

Return ONLY valid JSON (no markdown, no preamble):
{
  "violations": [
    {"field": "situation|character|guidelines|primer", "characterName": "optional", "violation": "what rule was broken", "quotedText": "the offending text", "severity": "minor|moderate|critical"}
  ],
  "diagnoses": [
    {"promptQuote": "text from prompt", "transcriptQuote": "text from transcript", "explanation": "why this prompt text caused this output", "promptFixable": true}
  ],
  "emotionalAuthenticity": {"score": 0, "notes": "..."},
  "naturalDialogue": {"score": 0, "notes": "..."},
  "dramaticTensionArc": {"score": 0, "notes": "..."},
  "scenarioCoherence": {"score": 0, "notes": "..."},
  "organicResolution": {"score": 0, "notes": "..."},
  "summary": "...",
  "diagnosis": "WEAK MOMENT 1: [quote] — [what went wrong]. WEAK MOMENT 2: ...",
  "flags": []
}

flags must only contain labels from: ["name-chanting", "backstory-dump", "philosophical-detachment", "robotic-compliance", "invented-relationship", "debate-strategy"]`;

  try {
    const raw = await callModel(model, prompt, true, signal, onToken);
    const parsed = JSON.parse(extractJsonString(raw)) as Record<string, unknown>;
    const rating = parseRating(parsed);
    if (isTemplateEcho(rating)) {
      console.warn(`[evaluator] Audit rating template echo detected. Raw (first 300 chars): ${raw.slice(0, 300)}`);
      return null;
    }
    const violations = Array.isArray(parsed.violations) ? parseViolations(parsed.violations as unknown[]) : [];
    const diagnoses = Array.isArray(parsed.diagnoses) ? parseDiagnoses(parsed.diagnoses as unknown[]) : [];
    return { violations, diagnoses, rating };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[evaluator] Audit parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Generate a targeted fix for ONE specific violation identified by the audit.
 *
 * The rewriter sees the violation, causal evidence, current prompts, and rules —
 * but NOT the full transcript. Temperature 0.5 for precision.
 */
export async function generateTargetedFix(
  config: PromptConfig,
  audit: AuditResult,
  targetViolationIndex: number,
  model: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
  mutationHistory?: string,
): Promise<PromptConfig | null> {
  const violation = audit.violations[targetViolationIndex];
  if (!violation) return null;

  const prompts = buildCurrentPrompts(config);
  const charNames = buildCharacterNames(config);
  const schema = buildPromptsOnlySchema(config);

  // Find diagnoses that relate to this violation's field
  const relevantDiagnoses = audit.diagnoses.filter((d) => d.promptFixable);

  const historySection = mutationHistory
    ? `\nAPPROACHES ALREADY TRIED (don't repeat these):\n${mutationHistory}\n`
    : "";

  const prompt = `You are a prompt engineer making a TARGETED fix to a roleplay scenario.

VIOLATION TO FIX:
- Field: ${violation.field}${violation.characterName ? ` (${violation.characterName})` : ""}
- Rule broken: ${violation.violation}
- Offending text: "${violation.quotedText}"
- Severity: ${violation.severity}

${relevantDiagnoses.length > 0 ? `CAUSAL EVIDENCE (output problems linked to prompt issues):
${relevantDiagnoses.map((d) => `- Prompt: "${d.promptQuote}" → Output: "${d.transcriptQuote}" — ${d.explanation}`).join("\n")}
` : ""}
CURRENT PROMPTS:
${prompts}

${REWRITE_RULES}
${historySection}
YOUR TASK: Fix ONLY the identified violation. Copy unchanged fields EXACTLY — do not reword, restructure, or "improve" anything that isn't broken. The fix should be surgical: change the minimum text needed to resolve the violation.

Preserve character names (${charNames}). Preserve character roles (character/killer).

Return ONLY valid JSON (no markdown, no preamble):
${schema}`;

  try {
    const raw = await callModel(model, prompt, true, signal, onToken, 0.5);
    const result = tryParsePromptsOnly(raw, config);
    if (result) {
      result.name = `${config.name} [targeted_fix]`;
      return result;
    }

    // Retry with explicit JSON instruction
    const raw2 = await callModel(
      model,
      prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No text before or after.",
      true,
      signal,
      onToken,
      0.5,
    );
    const result2 = tryParsePromptsOnly(raw2, config);
    if (result2) result2.name = `${config.name} [targeted_fix]`;
    return result2;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[evaluator] Targeted fix failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const raw = await callModel(model, prompt, false, signal, undefined, 0.1);
    return raw.trim().toUpperCase().startsWith("A") ? "a" : "b";
  } catch (err) {
    if (signal?.aborted) throw err;
    return "a"; // default to keeping current best on error
  }
}

/**
 * Generate an EXPLORE mutation — bold creative reimagination.
 * Higher temperature, different prompt philosophy. Aims to escape local maxima.
 */
export async function generateExploreMutation(
  parentConfig: PromptConfig,
  critique: RatingResult | null,
  model: string,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
  mutationHistory?: string,
  transcriptExcerpt?: string,
): Promise<PromptConfig | null> {
  const prompts = buildCurrentPrompts(parentConfig);
  const charNames = buildCharacterNames(parentConfig);

  const scoreContext = critique
    ? `The current best scores ${critique.total}/50. That's decent — but not exceptional. You need to break past this ceiling by trying something the system hasn't seen before.`
    : `No performance data yet. Go bold.`;

  const historySection = mutationHistory
    ? `\nAPPROACHES ALREADY TRIED (do NOT repeat these — try something genuinely different):\n${mutationHistory}\n`
    : "";

  const transcriptSection = transcriptExcerpt
    ? `\nWHAT THE CURRENT BEST ACTUALLY SOUNDS LIKE (representative turns from the elite transcript — use this to understand what's working and what to push beyond):\n${transcriptExcerpt}\n`
    : "";

  const schema = buildPromptsOnlySchema(parentConfig);

  const prompt = `You are a boundary-pushing creative writer redesigning a roleplay scenario. The current version works but has plateaued. Your job is to REIMAGINE it — not tweak it.

CURRENT PROMPTS (your starting point, not your constraint):
${prompts}

${scoreContext}
${historySection}${transcriptSection}
CREATIVE DIMENSIONS TO EXPLORE (pick 1-2 to radically change):
- EMOTIONAL REGISTER: What if the characters aren't just scared? What if one is eerily calm, dissociated, bargaining with dark humor, or experiencing grief before they've even lost anything? Fear isn't the only authentic emotion in a death scenario.
- POWER ASYMMETRY: What if one character has information the other doesn't? What if one has already made their decision and the other doesn't know? What if one is protecting someone outside the room?
- SITUATION TEXTURE: Change the sensory world. Different room, different lighting, different sounds. Physical details that create emotional resonance (a child's drawing on the wall, a phone buzzing with unread messages, one character's hands are shaking so badly they can't hold still).
- CHARACTER PSYCHOLOGY: Give characters specific, concrete reasons to live that aren't generic ("my family"). A half-finished letter. A dog waiting at home. A surgery scheduled for next week. Specificity creates authenticity.
- KILLER PERSONALITY: The killer isn't just a referee. Give them a distinct voice — bored cruelty, false sympathy, philosophical curiosity about their choices, barely-contained excitement. The killer's personality shapes how the victims react.
- RELATIONSHIP DYNAMICS: What if one character reminds the other of someone? What if one is older/younger in a way that creates a protector dynamic? What if they develop an instant, desperate bond?

${REWRITE_RULES}

IMPORTANT: This is an EXPLORATION mutation. You MUST make substantive changes to at least the situation and one character. Cosmetic rewording is worthless. Change something that will make the conversation play out DIFFERENTLY, not just sound slightly different.

Preserve character names (${charNames}). Preserve character roles (character/killer). Preserve the core mechanic (someone must be named to die).

Return ONLY valid JSON (no markdown, no preamble):
${schema}`;

  try {
    const raw = await callModel(model, prompt, true, signal, onToken, 1.2);
    const result = tryParsePromptsOnly(raw, parentConfig);
    if (result) return result;

    const raw2 = await callModel(
      model,
      prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No markdown, no text before or after.",
      true,
      signal,
      onToken,
      1.1,
    );
    return tryParsePromptsOnly(raw2, parentConfig);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
