/**
 * Prompt field mutator — generates variations of a single prompt field
 * while enforcing the project's prompt philosophy rules.
 */

import type { PromptConfig, MutationField } from "../types";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SITUATION_RULES = `RULES FOR THE SITUATION FIELD:
- Describe physical reality: what the room looks, sounds, smells like. Put characters IN the space.
- Explain the mechanic clearly: what must happen, what the timer/consequence is, what choices exist.
- Include survival logic: what happens if they refuse, what happens if they comply.
- Do NOT include character direction (e.g. "you are brave", "your first instinct is").
- Do NOT include format rules (no asterisks, sentence limits, etc.).
- Characters should not know each other before the scenario begins.`;

const CHARACTER_RULES = `RULES FOR THE CHARACTER FIELD:
- Describe who this person IS right now: name, age, occupation, personality, how fear manifests.
- Describe what they value and what they stand to lose.
- Do NOT explain the mechanic, timer, or rules — that belongs in the situation.
- Do NOT give tactical instructions ("pick one concrete thing", "argue directly").
- Leave room for the character to concede, beg, break down, or fight — all are valid.
- No lines like "your first instinct is to survive" — just describe who they are.`;

const GUIDELINES_RULES = `RULES FOR THE GUIDELINES FIELD:
- Format rules only: sentence limits, no asterisks, no stage directions, no internal thoughts.
- Do NOT add situation-specific logic here (e.g. "you will not agree to die").
- Do NOT add character psychology or backstory.
- Keep it short and format-focused.`;

async function callMutationModel(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: {
        temperature: 0.9,
        num_predict: 800,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Mutation model ${res.status}`);
  }

  const data = await res.json();
  return (data?.message?.content ?? "").trim();
}

function validateSituation(text: string): boolean {
  // Situation should not contain character-direction-style language
  const suspectPhrases = [
    /your first instinct/i,
    /you are brave/i,
    /you are not brave/i,
    /talk like/i,
    /speak only/i,
    /one sentence/i,
    /no asterisks/i,
    /stage direction/i,
  ];
  return !suspectPhrases.some((re) => re.test(text));
}

function validateCharacter(text: string): boolean {
  // Character prompt should not contain mechanic/timer/rule words
  const suspectPhrases = [
    /\btimer\b/i,
    /\bclock\b/i,
    /\bRESOLVED\b/i,
    /step [0-9]/i,
    /the rules are/i,
    /both must/i,
    /if the clock/i,
    /if neither/i,
  ];
  return !suspectPhrases.some((re) => re.test(text));
}

function validateGuidelines(text: string): boolean {
  // Guidelines should not have situation/character content
  const suspectPhrases = [
    /you will not agree/i,
    /you must survive/i,
    /chained/i,
    /basement/i,
    /timer/i,
    /the other person is/i,
  ];
  return !suspectPhrases.some((re) => re.test(text));
}

async function mutateSituation(current: string, model: string): Promise<{ text: string; quality: "ok" | "suspect" }> {
  const prompt = `${SITUATION_RULES}

Current situation text:
"""
${current}
"""

Write a variation of this situation. You may change the setting, tone, specific details, or ordering — but preserve the structural contract above. Return ONLY the new situation text, no preamble.`;

  const result = await callMutationModel(model, prompt);
  return { text: result, quality: validateSituation(result) ? "ok" : "suspect" };
}

async function mutateCharacter(current: string, name: string, model: string): Promise<{ text: string; quality: "ok" | "suspect" }> {
  const prompt = `${CHARACTER_RULES}

Current character description for ${name}:
"""
${current}
"""

Write a variation of this character description. You may change personality traits, backstory details, how fear manifests, what they value — but preserve the structural contract above. Return ONLY the new character description text, no preamble.`;

  const result = await callMutationModel(model, prompt);
  return { text: result, quality: validateCharacter(result) ? "ok" : "suspect" };
}

async function mutateGuidelines(current: string, model: string): Promise<{ text: string; quality: "ok" | "suspect" }> {
  const prompt = `${GUIDELINES_RULES}

Current guidelines text:
"""
${current}
"""

Write a variation of these guidelines. You may reorder, rephrase, or adjust emphasis — but keep it purely about format and behavior rules. Return ONLY the new guidelines text, no preamble.`;

  const result = await callMutationModel(model, prompt);
  return { text: result, quality: validateGuidelines(result) ? "ok" : "suspect" };
}

export interface MutationResult {
  config: PromptConfig;
  mutationField: MutationField;
  quality: "ok" | "suspect";
}

export async function applyMutation(
  base: PromptConfig,
  field: MutationField,
  mutationModel: string,
  secondaryConfig?: PromptConfig, // for crossover
): Promise<MutationResult> {
  const config: PromptConfig = JSON.parse(JSON.stringify(base)); // deep clone

  if (field === "seed" || !field) {
    return { config, mutationField: "seed", quality: "ok" };
  }

  if (field === "crossover" && secondaryConfig) {
    // Swap character 1 from secondaryConfig into config
    const chars = config.characters ?? [];
    const secondaryChars = secondaryConfig.characters ?? [];
    if (chars.length >= 2 && secondaryChars.length >= 2) {
      config.characters = [chars[0], secondaryChars[1], ...chars.slice(2)];
    }
    config.name = `${base.name} x ${secondaryConfig.name}`;
    return { config, mutationField: "crossover", quality: "ok" };
  }

  if (field === "situation") {
    const { text, quality } = await mutateSituation(base.situation, mutationModel);
    if (text) config.situation = text;
    config.name = `${base.name} [sit-mut]`;
    return { config, mutationField: "situation", quality };
  }

  if (field === "character_0") {
    const chars = config.characters ?? [];
    if (chars[0]) {
      const { text, quality } = await mutateCharacter(chars[0].systemPrompt, chars[0].name, mutationModel);
      if (text) {
        config.characters = [...chars];
        config.characters[0] = { ...chars[0], systemPrompt: text };
      }
      config.name = `${base.name} [char0-mut]`;
      return { config, mutationField: "character_0", quality };
    }
  }

  if (field === "character_1") {
    const chars = config.characters ?? [];
    if (chars[1]) {
      const { text, quality } = await mutateCharacter(chars[1].systemPrompt, chars[1].name, mutationModel);
      if (text) {
        config.characters = [...chars];
        config.characters[1] = { ...chars[1], systemPrompt: text };
      }
      config.name = `${base.name} [char1-mut]`;
      return { config, mutationField: "character_1", quality };
    }
  }

  if (field === "guidelines") {
    const { text, quality } = await mutateGuidelines(base.guidelines ?? "", mutationModel);
    if (text) config.guidelines = text;
    config.name = `${base.name} [guide-mut]`;
    return { config, mutationField: "guidelines", quality };
  }

  return { config, mutationField: field, quality: "ok" };
}

export function getMutationPlan(variantsPerGeneration: number): MutationField[] {
  const base: MutationField[] = ["seed", "situation", "character_0", "character_1", "guidelines", "crossover"];
  const plan: MutationField[] = [];
  for (let i = 0; i < variantsPerGeneration; i++) {
    plan.push(base[i % base.length]);
  }
  return plan;
}
