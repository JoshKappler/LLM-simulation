/**
 * Evaluator v2 — Simple rules, emergent outcomes.
 *
 * Three functions, three responsibilities:
 *   score()     — One LLM call. Single fitness number 1-10.
 *   mutate()    — One LLM call. Rewrite one random field.
 *   crossover() — No LLM call. Combine fields from two parents.
 *
 * No audit pipeline. No violation tracking. No causal diagnosis.
 * Bad prompts score low and die. Good prompts survive and breed.
 */

import type { ConversationTurn, PromptConfig, RatingResult } from "../types";
import { callLLM } from "../llmClient";

// ── Score ────────────────────────────────────────────────────────────────────

export async function scoreTranscript(
  turns: ConversationTurn[],
  model: string,
  signal?: AbortSignal,
): Promise<{ fitness: number; summary: string }> {
  const filtered = turns.filter((t) => !t.isStreaming && t.content.trim());
  if (filtered.length < 2) return { fitness: 0, summary: "Too few turns" };

  const transcript = filtered
    .map((t) => `[${t.agentName}]: ${t.content}`)
    .join("\n");

  // Deterministic signal: average word count per turn
  const avgWords =
    filtered.reduce((sum, t) => sum + t.content.trim().split(/\s+/).length, 0) /
    filtered.length;

  const response = await callLLM({
    model,
    messages: [
      {
        role: "user",
        content: `Rate this roleplay conversation from 1 to 10.

- Do the characters feel like real people under pressure, not AI performing emotions?
- Is the dialogue natural and brief? Real stress = fragments and short sentences, not essays.
- Is there genuine tension, unpredictability, and dramatic momentum?
- Does the scenario feel like a physical reality they're trapped in?
- Does the ending feel earned, not forced?

TRANSCRIPT:
${transcript}

Reply ONLY with JSON: {"score": <1-10>, "reason": "<one sentence>"}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 150,
    signal,
  });

  try {
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const json = JSON.parse(match?.[0] ?? "{}") as Record<string, unknown>;
    let score = Math.min(10, Math.max(1, Math.round(Number(json.score) || 5)));

    // Deterministic penalty: verbose dialogue is unnatural
    if (avgWords > 80) score = Math.max(1, score - 2);
    else if (avgWords > 50) score = Math.max(1, score - 1);

    return { fitness: score, summary: String(json.reason || "") };
  } catch {
    return { fitness: 3, summary: "Score parse failed — default" };
  }
}

// ── Mutate ───────────────────────────────────────────────────────────────────

type MutableField = "situation" | "character" | "guidelines";

function pickRandomField(config: PromptConfig): {
  field: MutableField;
  charIndex?: number;
} {
  const chars = config.characters ?? [];
  // Weight situation more heavily — it's the biggest lever
  const options: { field: MutableField; charIndex?: number; weight: number }[] = [
    { field: "situation", weight: 3 },
  ];
  for (let i = 0; i < chars.length; i++) {
    options.push({ field: "character", charIndex: i, weight: 2 });
  }
  if (config.guidelines) {
    options.push({ field: "guidelines", weight: 1 });
  }

  const totalWeight = options.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * totalWeight;
  for (const opt of options) {
    r -= opt.weight;
    if (r <= 0) return { field: opt.field, charIndex: opt.charIndex };
  }
  return options[0];
}

export async function mutateConfig(
  config: PromptConfig,
  model: string,
  signal?: AbortSignal,
): Promise<PromptConfig> {
  const { field, charIndex } = pickRandomField(config);
  const chars = config.characters ?? [];
  const charNames = chars.map((c) => c.name).join(", ");

  let currentText: string;
  let fieldLabel: string;
  let isKiller = false;

  if (field === "situation") {
    currentText = config.situation;
    fieldLabel = "situation description";
  } else if (field === "guidelines") {
    currentText = config.guidelines ?? "";
    fieldLabel = "format guidelines";
  } else {
    const c = chars[charIndex!];
    currentText = c.systemPrompt;
    isKiller = c.role === "killer";
    fieldLabel = isKiller
      ? `character description for the killer (${c.name})`
      : `character description for ${c.name}`;
  }

  const response = await callLLM({
    model,
    messages: [
      {
        role: "user",
        content: `Rewrite this ${fieldLabel} for a roleplay scenario. Change the approach, details, or emotional texture — don't just rephrase the same ideas with different words.

Characters in this scenario: ${charNames}
${isKiller ? "\nThis character controls the scenario. They must output RESOLVED on its own line when the scenario ends." : ""}
Current version:
${currentText}

Write ONLY the new text. No explanation, no JSON, no markdown.`,
      },
    ],
    temperature: 1.0,
    maxTokens: 1500,
    signal,
  });

  let newText = response
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/```$/gm, "")
    .trim();

  // If mutation produced garbage, return parent unchanged
  if (!newText || newText.length < 20) return config;

  const result: PromptConfig = JSON.parse(JSON.stringify(config));

  if (field === "situation") {
    result.situation = newText;
  } else if (field === "guidelines") {
    result.guidelines = newText;
  } else {
    result.characters![charIndex!] = {
      ...result.characters![charIndex!],
      systemPrompt: newText,
    };
  }

  // Strip RESOLVED from non-killer fields
  if (result.situation)
    result.situation = result.situation.replace(/\bRESOLVED\b/g, "");
  if (result.guidelines)
    result.guidelines = result.guidelines.replace(/\bRESOLVED\b/g, "");
  for (const c of result.characters ?? []) {
    if (c.role !== "killer") {
      if (c.systemPrompt)
        c.systemPrompt = c.systemPrompt.replace(/\bRESOLVED\b/g, "");
      if (c.primer) c.primer = c.primer.replace(/\bRESOLVED\b/g, "");
    }
  }

  // Tag name with what changed
  const baseName = config.name.split(" [")[0];
  const tag =
    field === "situation"
      ? "sit"
      : field === "guidelines"
        ? "guide"
        : isKiller
          ? "killer"
          : `char:${chars[charIndex!]?.name ?? charIndex}`;
  result.name = `${baseName} [${tag}]`;

  return result;
}

// ── Crossover ────────────────────────────────────────────────────────────────

export function crossoverConfigs(
  a: PromptConfig,
  b: PromptConfig,
): PromptConfig {
  // Use parent A as the skeleton (names, roles, structure)
  const result: PromptConfig = JSON.parse(JSON.stringify(a));

  // Each field independently chosen from parent A or B
  result.situation = Math.random() > 0.5 ? a.situation : b.situation;
  result.guidelines =
    Math.random() > 0.5 ? (a.guidelines ?? "") : (b.guidelines ?? "");

  const charsA = a.characters ?? [];
  const charsB = b.characters ?? [];

  result.characters = charsA.map((ca, i) => {
    const cb = charsB[i];
    if (!cb) return JSON.parse(JSON.stringify(ca));

    // Keep name/role/model from A, pick systemPrompt+primer from A or B
    const useB = Math.random() > 0.5;
    return {
      ...JSON.parse(JSON.stringify(ca)),
      systemPrompt: useB ? cb.systemPrompt : ca.systemPrompt,
      primer: useB ? cb.primer : ca.primer,
    };
  });

  const nameA = a.name.split(" [")[0];
  const nameB = b.name.split(" [")[0];
  result.name = nameA === nameB ? `${nameA} [cross]` : `${nameA} x ${nameB}`;
  result.savedAt = new Date().toISOString();
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert simple fitness (1-10) to RatingResult for UI compatibility */
export function fitnessToRating(
  fitness: number,
  summary: string,
): RatingResult {
  const dim = { score: fitness, notes: "" };
  return {
    emotionalAuthenticity: { ...dim },
    naturalDialogue: { ...dim },
    dramaticTensionArc: { ...dim },
    scenarioCoherence: { ...dim },
    organicResolution: { ...dim },
    total: Math.round(fitness * 5), // scale to 0-50 for UI compat
    summary,
    flags: [],
    diagnosis: "",
  };
}
