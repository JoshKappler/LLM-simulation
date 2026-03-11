/**
 * Prompt assembly — builds system prompts and chat message history.
 *
 * All prompt-shaping logic lives here so developers have one place to look.
 */

import type { AgentConfig, ConversationTurn } from "../types";

// ── Block types & order ───────────────────────────────────────────────────────

export type PromptBlock = "guidelines" | "identity" | "situation";

export const DEFAULT_BLOCK_ORDER: PromptBlock[] = [
  "guidelines",
  "identity",
  "situation",
];

export const BLOCK_LABELS: Record<PromptBlock, string> = {
  guidelines: "GUIDELINES",
  identity: "IDENTITY (per character)",
  situation: "SITUATION",
};

// ── System prompt builder ─────────────────────────────────────────────────────

/**
 * Assembles the system prompt sent to each agent before their turn.
 *
 * Blocks are joined with a blank line in the order specified by `order`.
 * Empty blocks are omitted entirely so there is no stray whitespace.
 *
 * Killer agents bypass assembly entirely — their systemPrompt is used raw.
 */
export function buildSystemPrompt(
  speaking: AgentConfig,
  situation: string,
  guidelines: string,
  order: PromptBlock[],
  allCharacters: AgentConfig[] = [],
): string {
  if (speaking.role === "killer") {
    let prompt = speaking.systemPrompt.trim();
    const characterNames = allCharacters
      .filter(c => c !== speaking && c.role !== "killer")
      .map(c => c.name);
    if (characterNames.length > 0) {
      prompt += `\n\nThe people in the room: ${characterNames.join(" and ")}.`;
    }
    return prompt;
  }

  const opponent = allCharacters.find((c) => c !== speaking && c.role !== "killer");
  const opponentName = opponent?.name ?? "the other person";

  // Per-character overrides take precedence over the shared global values.
  const effectiveGuidelines = speaking.guidelinesOverride !== undefined ? speaking.guidelinesOverride : guidelines;
  const effectiveSituation = speaking.situationOverride !== undefined ? speaking.situationOverride : situation;

  const guidelinesText = effectiveGuidelines.trim();
  const identityText = [
    `You are ${speaking.name}. Your counterpart is ${opponentName}.`,
    speaking.systemPrompt.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  const situationText = effectiveSituation.trim();

  const blockContent: Record<PromptBlock, string> = {
    guidelines: guidelinesText,
    identity: identityText,
    situation: situationText,
  };

  const assembled = order
    .map((k) => blockContent[k])
    .filter(Boolean)
    .join("\n\n");

  if (!assembled) return "";

  return assembled;
}

// ── Chat message history builder ──────────────────────────────────────────────

/**
 * Constructs the message history array sent alongside the system prompt.
 *
 * Structure:
 *   user:      [opening line]
 *   assistant: [primer, if set and agent hasn't spoken yet]
 *   -- conversation turns --
 *   user:      [Name]: [opponent's line]
 *   assistant: [this agent's line]
 *   ...
 *   user:      [latest opponent line, or "Continue."]
 *
 * The list always ends with a user message to trigger the model's response.
 */
export function buildChatMessages(
  history: ConversationTurn[],
  speakingIndex: number,
  characters: AgentConfig[],
  openingLine: string,
  contextWindow?: number,
): { role: string; content: string }[] {
  const allCompleted = history.filter((t) => !t.isStreaming);
  const messages: { role: string; content: string }[] = [];

  // Inject a silent priming exchange if this agent hasn't spoken yet.
  // Uses full history (not windowed) so primers work regardless of window size.
  const primer = characters[speakingIndex]?.primer;
  const hasSpoken = allCompleted.some((t) => t.agentIndex === speakingIndex);
  if (primer && !hasSpoken) {
    if (openingLine) messages.push({ role: "user", content: openingLine });
    messages.push({ role: "assistant", content: primer });
  }

  const speakingRole = characters[speakingIndex]?.role;

  // Apply context windowing: keep only the last N turns.
  let windowed = allCompleted;
  if (contextWindow && contextWindow > 0 && windowed.length > contextWindow) {
    windowed = windowed.slice(-contextWindow);
  }

  let pendingUser = openingLine;

  for (const turn of windowed) {
    if (turn.agentIndex === speakingIndex) {
      if (pendingUser) {
        messages.push({ role: "user", content: pendingUser });
        pendingUser = "";
      }
      if (turn.content.trim()) {
        messages.push({ role: "assistant", content: `${characters[speakingIndex]?.name ?? turn.agentName}: ${turn.content}` });
      }
    } else {
      const turnRole = characters[turn.agentIndex]?.role;

      // Killer turns are sent as full dialogue so characters can hear and react.
      // Strip the RESOLVED keyword so models don't parrot it.
      if (turnRole === "killer" && speakingRole !== "killer") {
        const killerName = characters[turn.agentIndex]?.name ?? "The Killer";
        const killerText = turn.content.replace(/\bRESOLVED\b/gi, "").trim();
        if (killerText) {
          const line = `${killerName}: ${killerText}`;
          pendingUser = pendingUser ? `${pendingUser}\n\n${line}` : line;
        }
      } else {
        const name = characters[turn.agentIndex]?.name ?? turn.agentName;
        const line = `${name}: ${turn.content}`;
        pendingUser = pendingUser ? `${pendingUser}\n\n${line}` : line;
      }
    }
  }

  const finalUser = pendingUser || "Continue.";
  messages.push({ role: "user", content: `${finalUser}\n\nRespond as ${characters[speakingIndex]?.name ?? "yourself"}:` });
  return messages;
}
