/**
 * Headless run executor — server-side equivalent of the browser run loop.
 * Calls Ollama directly without going through the Next.js /api/chat proxy.
 */

import type { AgentConfig, ConversationTurn, PromptConfig } from "../types";
import { buildSystemPrompt, buildChatMessages, DEFAULT_BLOCK_ORDER } from "../prompting/assembly";
import type { PromptBlock } from "../prompting/assembly";
import { isLooping, shouldKillerSpeak } from "../prompting/turnOrder";
import { cleanOutput } from "../cleanOutput";
import { streamLLM } from "../llmClient";

export type TerminationReason = "resolved" | "looping" | "max_turns" | "error" | "stopped";

export interface ExecutorResult {
  turns: ConversationTurn[];
  terminationReason: TerminationReason;
  errorMessage?: string;
}

interface ExecutorOptions {
  maxTurns: number;
  temperature: number;
  numPredict?: number;
  minP?: number;
  contextWindow?: number;
  killerFirstThreshold?: number;
  killerInterval?: number;
  stopFlag?: { current: boolean };
  signal?: AbortSignal;
  onToken?: (agentIndex: number, agentName: string, token: string) => void;
}

const CALL_TIMEOUT_MS = 120_000; // 2-minute hard timeout per LLM call

async function callModel(
  model: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
  options: { temperature: number; numPredict?: number; stop?: string[]; signal?: AbortSignal; onToken?: (token: string) => void },
): Promise<string> {
  if (options.signal?.aborted) {
    throw Object.assign(new Error("AbortError"), { name: "AbortError" });
  }

  // Combine job abort signal with a per-call timeout so a hanging API request
  // doesn't block the run indefinitely.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error("LLM call timed out")), CALL_TIMEOUT_MS);
  const onParentAbort = () => timeoutController.abort(options.signal!.reason ?? new Error("Job aborted"));
  if (options.signal && !options.signal.aborted) {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  } else if (options.signal?.aborted) {
    clearTimeout(timeoutId);
    throw Object.assign(new Error("AbortError"), { name: "AbortError" });
  }
  const combined = timeoutController.signal;

  const llmMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  let fullContent = "";
  try {
    for await (const chunk of streamLLM({
      model,
      messages: llmMessages,
      temperature: options.temperature,
      ...(options.numPredict !== undefined && { maxTokens: options.numPredict }),
      ...(options.stop?.length && { stop: options.stop }),
      signal: combined,
    })) {
      fullContent += chunk;
      options.onToken?.(chunk);
    }
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
  return fullContent;
}

/**
 * Execute a single agent turn: build prompt, call model, clean output.
 * Returns the cleaned text, or "" if the model produced nothing usable.
 */
async function executeTurn(
  agentIndex: number,
  characters: AgentConfig[],
  history: ConversationTurn[],
  situation: string,
  guidelines: string,
  blockOrder: PromptBlock[],
  options: ExecutorOptions,
): Promise<{ cleaned: string; rawContent: string; error?: string }> {
  const speaking = characters[agentIndex];

  const system = buildSystemPrompt(speaking, situation, guidelines, blockOrder, characters);
  const messages = buildChatMessages(history, agentIndex, characters, "", options.contextWindow ?? 12);

  const stop = characters
    .filter((c) => c.name !== speaking.name)
    .map((c) => `${c.name}:`);

  let rawContent = "";
  try {
    rawContent = await callModel(speaking.model, system, messages, {
      temperature: options.temperature,
      numPredict: speaking.numPredict ?? options.numPredict ?? 2000,
      stop,
      signal: options.signal,
      onToken: options.onToken
        ? (tok) => options.onToken!(agentIndex, speaking.name, tok)
        : undefined,
    });
  } catch (err) {
    if (options.signal?.aborted) {
      return { cleaned: "", rawContent: "", error: "AbortError" };
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { cleaned: "", rawContent: "", error: errorMessage };
  }

  const allNames = characters.map((c) => c.name);
  let cleaned = cleanOutput(rawContent, speaking.name, allNames);
  if (!cleaned && speaking.role === "killer") {
    // Killer output was fully stripped (e.g. asterisk-wrapped stage directions).
    // Apply lighter cleaning: preserve inner asterisk content instead of dropping it.
    const speakerEsc = speaking.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*/i, "")
      .replace(new RegExp(`^\\s*${speakerEsc}\\s*:\\s*`, "i"), "")
      .replace(/\*([^*]+)\*/g, "$1")
      .trim();
  }

  return { cleaned, rawContent };
}

export async function runHeadless(
  config: PromptConfig,
  options: ExecutorOptions,
  onTurn: (turn: ConversationTurn) => void,
): Promise<ExecutorResult> {
  const characters: AgentConfig[] = config.characters ?? [
    ...(config.agentA ? [config.agentA] : []),
    ...(config.agentB ? [config.agentB] : []),
  ];

  if (characters.length === 0) {
    return { turns: [], terminationReason: "error" };
  }

  const blockOrder = (config.promptBlockOrder as PromptBlock[] | undefined) ?? DEFAULT_BLOCK_ORDER;
  const situation = config.situation ?? "";
  const guidelines = config.guidelines ?? "";

  // Identify non-killer and killer agents for separate turn management.
  // Non-killer agents strictly alternate; the killer is interjected on schedule.
  const nonKillerIndices = characters.map((_, i) => i).filter((i) => characters[i].role !== "killer");
  const killerIndex = characters.findIndex((c) => c.role === "killer");

  if (nonKillerIndices.length === 0) {
    return { turns: [], terminationReason: "error" };
  }

  // Seed primer turns (silently added to history, not emitted)
  const history: ConversationTurn[] = [];
  for (let i = 0; i < characters.length; i++) {
    if (characters[i]?.primer) {
      history.push({
        agentIndex: i,
        agentName: characters[i].name,
        content: characters[i].primer!,
        isStreaming: false,
      });
    }
  }

  // Determine starting rotation from primers already in history
  let nonKillerRotation = 0;
  for (const turn of history) {
    if (nonKillerIndices.includes(turn.agentIndex)) {
      nonKillerRotation++;
    }
  }

  let turnCount = history.length; // primers count toward the turn limit
  const MAX_TURNS = options.maxTurns;
  const MAX_CONSECUTIVE_EMPTY = 4; // terminate if agents keep producing nothing
  let consecutiveEmpty = 0;

  while (turnCount < MAX_TURNS) {
    if (options.stopFlag?.current || options.signal?.aborted) {
      return { turns: history, terminationReason: "stopped" };
    }

    // ── Killer interjection check ──────────────────────────────────────────
    // Before each non-killer turn, check if the killer should speak.
    if (killerIndex !== -1 && shouldKillerSpeak(killerIndex, characters, history, options.killerFirstThreshold, options.killerInterval)) {
      const result = await executeTurn(killerIndex, characters, history, situation, guidelines, blockOrder, options);

      if (result.error) {
        if (result.error === "AbortError") {
          return { turns: history, terminationReason: "stopped" };
        }
        console.error(`[executor] callModel error (killer ${characters[killerIndex].name}):`, result.error);
        return { turns: history, terminationReason: "error", errorMessage: result.error };
      }

      if (result.cleaned) {
        const killerTurn: ConversationTurn = {
          agentIndex: killerIndex,
          agentName: characters[killerIndex].name,
          content: result.cleaned,
          isStreaming: false,
        };
        history.push(killerTurn);
        onTurn(killerTurn);
        turnCount++;

        if (turnCount >= MAX_TURNS) break;

        if (isLooping(history)) {
          return { turns: history, terminationReason: "looping" };
        }

        if (/\bRESOLVED\b/i.test(result.cleaned)) {
          return { turns: history, terminationReason: "resolved" };
        }
      }

      // Re-check stop after killer turn
      if (options.stopFlag?.current || options.signal?.aborted) {
        return { turns: history, terminationReason: "stopped" };
      }
    }

    if (turnCount >= MAX_TURNS) break;

    // ── Non-killer turn (strict alternation) ───────────────────────────────
    const agentIndex = nonKillerIndices[nonKillerRotation % nonKillerIndices.length];
    const speaking = characters[agentIndex];

    const result = await executeTurn(agentIndex, characters, history, situation, guidelines, blockOrder, options);

    if (result.error) {
      if (result.error === "AbortError") {
        return { turns: history, terminationReason: "stopped" };
      }
      console.error(`[executor] callModel error (model: ${speaking.model}):`, result.error);
      return { turns: history, terminationReason: "error", errorMessage: result.error };
    }

    if (!result.cleaned) {
      // Don't advance rotation — retry the same agent next iteration to
      // maintain strict alternation in history. Count toward max turns so
      // we can't loop forever.
      turnCount++;
      consecutiveEmpty++;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
        return { turns: history, terminationReason: "error", errorMessage: "Too many consecutive empty turns" };
      }
      continue;
    }

    consecutiveEmpty = 0;
    nonKillerRotation++;
    turnCount++;

    const completedTurn: ConversationTurn = {
      agentIndex,
      agentName: speaking.name,
      content: result.cleaned,
      isStreaming: false,
    };
    history.push(completedTurn);
    onTurn(completedTurn);

    if (isLooping(history)) {
      return { turns: history, terminationReason: "looping" };
    }
  }

  return { turns: history, terminationReason: "max_turns" };
}
