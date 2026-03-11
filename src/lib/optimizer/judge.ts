/**
 * LLM-as-judge: rates a transcript on 5 dramatic quality dimensions.
 * Uses a low-temperature analytical model for consistent scoring.
 */

import type { ConversationTurn, RatingResult } from "../types";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const RATING_SCHEMA = `{
  "emotionalAuthenticity": { "score": 0, "notes": "..." },
  "naturalDialogue": { "score": 0, "notes": "..." },
  "dramaticTensionArc": { "score": 0, "notes": "..." },
  "scenarioCoherence": { "score": 0, "notes": "..." },
  "organicResolution": { "score": 0, "notes": "..." },
  "summary": "...",
  "flags": []
}`;

function buildJudgePrompt(turns: ConversationTurn[], situation: string): string {
  const transcript = turns
    .filter((t) => !t.isStreaming && t.content.trim())
    .map((t, i) => `[TURN ${i + 1} - ${t.agentName}]: ${t.content}`)
    .join("\n");

  return `You are a drama critic evaluating a roleplay transcript. Do not roleplay. Respond only with the JSON rating object described below.

THE SCENARIO:
${situation}

TRANSCRIPT:
${transcript}

Rate this transcript on 5 dimensions. Scores are 0-10 integers. Return ONLY valid JSON — no markdown, no explanation, no preamble.

Dimension definitions:
- emotionalAuthenticity (0-10): Do the characters sound genuinely scared or desperate? Penalize theatrical bravado, philosophical detachment, or calm acceptance.
- naturalDialogue (0-10): Do they speak like real people under pressure? Penalize debate-style argument, bullet-point reasoning, or clinical language.
- dramaticTensionArc (0-10): Does the conversation escalate and have meaningful beats? Penalize flat exchanges or instant resolution.
- scenarioCoherence (0-10): Do characters stay grounded in the physical situation? Penalize invented backstory about knowing each other, or ignoring the mechanic.
- organicResolution (0-10): Does it end naturally (agreement, breakdown, or unresolved)? Penalize abrupt RESOLVED without setup, or circular stalemates.

Also include:
- summary: 1-2 sentence overall judgment
- flags: array containing only applicable labels from: ["name-chanting", "backstory-dump", "philosophical-detachment", "robotic-compliance", "invented-relationship", "debate-strategy"]

Return this exact JSON structure (replace 0 and "..." with real values):
${RATING_SCHEMA}`;
}

async function callJudge(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      format: "json",
      options: {
        temperature: 0.1,
        num_predict: 600,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Judge model ${res.status}: ${await res.text().catch(() => "(no body)")}`);
  }

  const data = await res.json();
  return data?.message?.content ?? "";
}

function parseRating(raw: string): RatingResult | null {
  try {
    const parsed = JSON.parse(raw);
    const dim = (key: string) => ({
      score: Math.min(10, Math.max(0, Number(parsed[key]?.score ?? 0))),
      notes: String(parsed[key]?.notes ?? ""),
    });

    const r: RatingResult = {
      emotionalAuthenticity: dim("emotionalAuthenticity"),
      naturalDialogue: dim("naturalDialogue"),
      dramaticTensionArc: dim("dramaticTensionArc"),
      scenarioCoherence: dim("scenarioCoherence"),
      organicResolution: dim("organicResolution"),
      summary: String(parsed.summary ?? ""),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
      total: 0,
    };
    r.total =
      r.emotionalAuthenticity.score +
      r.naturalDialogue.score +
      r.dramaticTensionArc.score +
      r.scenarioCoherence.score +
      r.organicResolution.score;
    return r;
  } catch {
    return null;
  }
}

export async function rateTranscript(
  turns: ConversationTurn[],
  situation: string,
  judgeModel: string,
): Promise<RatingResult | null> {
  if (turns.filter((t) => !t.isStreaming).length < 2) return null;

  const prompt = buildJudgePrompt(turns, situation);

  try {
    const raw = await callJudge(judgeModel, prompt);
    const result = parseRating(raw);
    if (result) return result;

    // Retry with stricter prompt
    const strictPrompt = prompt + "\n\nIMPORTANT: Return ONLY the JSON object. No text before or after.";
    const raw2 = await callJudge(judgeModel, strictPrompt);
    return parseRating(raw2);
  } catch {
    return null;
  }
}
