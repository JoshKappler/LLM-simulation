/**
 * Headless run executor — server-side equivalent of the browser run loop.
 * Calls Ollama directly without going through the Next.js /api/chat proxy.
 */

import type { AgentConfig, ConversationTurn, PromptConfig, OllamaChunk } from "../types";
import { buildSystemPrompt, buildChatMessages, DEFAULT_BLOCK_ORDER } from "../prompting/assembly";
import type { PromptBlock } from "../prompting/assembly";
import { isLooping, shouldKillerSpeak } from "../prompting/turnOrder";
import { cleanOutput } from "../cleanOutput";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export type TerminationReason = "resolved" | "looping" | "max_turns" | "error" | "stopped";

export interface ExecutorResult {
  turns: ConversationTurn[];
  terminationReason: TerminationReason;
}

interface ExecutorOptions {
  maxTurns: number;
  temperature: number;
  numPredict?: number;
  minP?: number;
  contextWindow?: number;
  stopFlag?: { current: boolean };
}

async function callOllama(
  model: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
  options: { temperature: number; numPredict?: number; minP?: number; stop?: string[] },
): Promise<string> {
  const ollamaMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: ollamaMessages,
      stream: true,
      think: false,
      options: {
        temperature: options.temperature,
        repeat_penalty: 1.05,
        ...(options.numPredict !== undefined && { num_predict: options.numPredict }),
        ...(options.minP !== undefined && { min_p: options.minP }),
        ...(options.stop !== undefined && { stop: options.stop }),
      },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "(no body)")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const chunk = JSON.parse(trimmed) as OllamaChunk;
        if (chunk.message?.content) fullContent += chunk.message.content;
        if (chunk.done) break;
      } catch { /* partial line */ }
    }
  }

  return fullContent;
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

  // Seed primer turns
  const history: ConversationTurn[] = [];
  for (let i = 0; i < characters.length; i++) {
    if (characters[i]?.primer) {
      history.push({
        agentIndex: i,
        agentName: characters[i].name,
        content: characters[i].primer!,
        isStreaming: false,
      });
    } else {
      break;
    }
  }

  let agentIndex = history.length % characters.length;
  let turnCount = 0;
  const MAX_TURNS = options.maxTurns;

  while (turnCount < MAX_TURNS) {
    if (options.stopFlag?.current) {
      return { turns: history, terminationReason: "stopped" };
    }

    const speaking = characters[agentIndex];
    if (!speaking) {
      agentIndex = (agentIndex + 1) % characters.length;
      continue;
    }

    // Killer skip check
    if (speaking.role === "killer") {
      if (!shouldKillerSpeak(agentIndex, characters, history)) {
        agentIndex = (agentIndex + 1) % characters.length;
        continue;
      }
    }

    const system = buildSystemPrompt(speaking, situation, guidelines, blockOrder, characters);
    const messages = buildChatMessages(history, agentIndex, characters, "", options.contextWindow ?? 12);

    const stop = characters
      .filter((c) => c.name !== speaking.name)
      .map((c) => `${c.name}:`);

    let rawContent = "";
    try {
      rawContent = await callOllama(speaking.model, system, messages, {
        temperature: options.temperature,
        numPredict: speaking.numPredict ?? options.numPredict ?? 500,
        minP: options.minP ?? 0.05,
        stop,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { turns: history, terminationReason: "error" };
      void msg;
    }

    const allNames = characters.map((c) => c.name);
    const cleaned = cleanOutput(rawContent, speaking.name, allNames);

    if (!cleaned) {
      // Retry once with same agent (skip if still empty)
      agentIndex = (agentIndex + 1) % characters.length;
      continue;
    }

    const completedTurn: ConversationTurn = {
      agentIndex,
      agentName: speaking.name,
      content: cleaned,
      isStreaming: false,
    };
    history.push(completedTurn);
    onTurn(completedTurn);
    turnCount++;

    if (isLooping(history)) {
      return { turns: history, terminationReason: "looping" };
    }

    if (speaking.role === "killer" && /\bRESOLVED\b/i.test(cleaned)) {
      return { turns: history, terminationReason: "resolved" };
    }

    agentIndex = (agentIndex + 1) % characters.length;
  }

  return { turns: history, terminationReason: "max_turns" };
}
