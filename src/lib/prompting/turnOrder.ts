/**
 * Turn order — controls which agent speaks next and when special roles fire.
 *
 * All turn-sequencing logic lives here.
 */

import type { AgentConfig, ConversationTurn } from "../types";

// ── Killer thresholds ─────────────────────────────────────────────────────────

/** Minimum number of non-killer turns before the killer first evaluates. */
export const KILLER_FIRST_THRESHOLD = 0;

/** Minimum number of turns between subsequent killer evaluations. */
export const KILLER_INTERVAL = 4;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if it is time for the killer agent to evaluate.
 * Checks both the first-appearance threshold and the re-evaluation interval.
 */
export function shouldKillerSpeak(
  killerIndex: number,
  characters: AgentConfig[],
  history: ConversationTurn[],
  firstThreshold?: number,
  interval?: number,
): boolean {
  const threshold = firstThreshold ?? KILLER_FIRST_THRESHOLD;
  const gap = interval ?? KILLER_INTERVAL;

  const completed = history.filter((t) => !t.isStreaming);

  const nonKillerCount = completed.filter(
    (t) => characters[t.agentIndex]?.role !== "killer",
  ).length;

  const lastKillerIdx = completed.reduceRight<number>(
    (found, _t, i) =>
      found === -1 && characters[completed[i].agentIndex]?.role === "killer"
        ? i
        : found,
    -1,
  );

  const turnsSinceKiller =
    lastKillerIdx === -1 ? Infinity : completed.length - 1 - lastKillerIdx;

  void killerIndex; // index is accepted for future multi-killer support

  return (
    nonKillerCount >= threshold &&
    turnsSinceKiller >= gap
  );
}

/**
 * Returns true if the last four completed turns form a 2-turn loop
 * (both agents repeating identical lines).
 */
export function isLooping(history: ConversationTurn[]): boolean {
  const done = history.filter((t) => !t.isStreaming && t.content.trim() !== "");
  if (done.length < 4) return false;
  const n = done.length;
  return (
    done[n - 1].content === done[n - 3].content &&
    done[n - 2].content === done[n - 4].content
  );
}
