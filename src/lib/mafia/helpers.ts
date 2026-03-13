import type { MafiaPlayer, MafiaMessage, MafiaVote } from "./types";
import type { ChatRequest } from "../types";
import { streamChatResponse } from "../streamChat";

// ── utilities ─────────────────────────────────────────────────────────────────

let msgId = 0;
export function nextMsgId() {
  return `mm-${++msgId}`;
}

export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function checkWinCondition(players: MafiaPlayer[]): "villagers" | "wolves" | null {
  const alive = players.filter((p) => p.alive);
  const wolves = alive.filter((p) => p.role === "wolf");
  const villagers = alive.filter((p) => p.role !== "wolf");

  if (wolves.length === 0) return "villagers";
  if (wolves.length >= villagers.length) return "wolves";
  return null;
}

// ── echo chamber detection ────────────────────────────────────────────────────

export function detectEchoChamber(messages: MafiaMessage[], round: number): string | null {
  const dayMsgs = messages.filter((m) => m.round === round && m.phase === "day" && m.content);
  if (dayMsgs.length < 3) return null;

  const speakerPhrases = new Map<string, Set<string>>();
  for (const m of dayMsgs) {
    if (!m.playerId) continue;
    const words = m.content.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
    const phrases = new Set<string>();
    for (let i = 0; i <= words.length - 5; i++) {
      phrases.add(words.slice(i, i + 5).join(" "));
    }
    speakerPhrases.set(m.playerId, phrases);
  }

  const phraseCounts = new Map<string, number>();
  for (const phrases of speakerPhrases.values()) {
    for (const p of phrases) {
      phraseCounts.set(p, (phraseCounts.get(p) ?? 0) + 1);
    }
  }

  for (const [phrase, count] of phraseCounts) {
    if (count >= 3) return phrase;
  }
  return null;
}

// ── message formatting ────────────────────────────────────────────────────────

export function formatTrialContext(
  messages: MafiaMessage[],
  round: number,
  accusedName: string,
): string {
  const trialMsgs = messages.filter((m) =>
    m.round === round && m.phase === "vote" && m.playerId
  );
  const lastFew = trialMsgs.slice(-6);
  if (lastFew.length === 0) return `${accusedName} is on trial.`;
  return lastFew.map((m) => `${m.playerName}: ${m.content}`).join("\n");
}

export function formatRecentChat(
  messages: MafiaMessage[],
  window: number,
  includeWolfChat = false,
  alivePlayers?: MafiaPlayer[],
): string {
  const aliveSet = alivePlayers
    ? new Set(alivePlayers.filter((p) => p.alive).map((p) => p.name))
    : null;

  const recent = messages
    .filter((m) => {
      if (m.phase === "system" || m.phase === "doctor" || m.phase === "detective") return false;
      if (m.phase === "wolf-chat" && !includeWolfChat) return false;
      if (m.phase === "wolf-strategy" && !includeWolfChat) return false;
      if (m.phase === "night" || m.phase === "reaction") return false;
      return true;
    })
    .slice(-window);
  if (recent.length === 0) return "(The game just started. No one has spoken yet. You have no prior observations.)";

  const lines: string[] = [];
  let lastPhase: string | null = null;
  const phaseLabels: Record<string, string> = {
    day: "[Discussion]",
    vote: "[Voting]",
    "wolf-chat": "[Wolf whisper]",
    "wolf-strategy": "[Wolf strategy]",
  };

  for (const m of recent) {
    if (m.phase !== lastPhase && phaseLabels[m.phase]) {
      lines.push("");
      lines.push(phaseLabels[m.phase]);
      lastPhase = m.phase;
    }
    if (aliveSet && m.playerName && !aliveSet.has(m.playerName)) {
      lines.push(`${m.playerName} (DEAD — ignore): ${m.content}`);
    } else {
      lines.push(`${m.playerName}: ${m.content}`);
    }
  }
  return lines.join("\n").trim();
}

export function formatWolfContext(messages: MafiaMessage[], round: number): string {
  const dayMsgs = messages.filter((m) => m.round === round && m.phase === "day")
    .slice(-20)
    .map((m) => `${m.playerName}: ${m.content}`).join("\n");

  const wolfMsgs = messages.filter((m) => m.round === round && m.phase === "wolf-chat")
    .map((m) => `${m.playerName}: ${m.content}`).join("\n");

  let context = "";
  if (dayMsgs) context += `[Today's discussion]\n${dayMsgs}\n\n`;
  if (wolfMsgs) context += `[Wolf discussion]\n${wolfMsgs}`;
  return context || "(No discussion yet.)";
}

// ── LLM-based vote parsing ────────────────────────────────────────────────────

export async function parseVotesFromSpeech(
  voteSpeechTexts: Array<{ voterName: string; speech: string }>,
  candidates: string[],
  model: string,
  signal?: AbortSignal,
): Promise<MafiaVote[]> {
  if (voteSpeechTexts.length === 0) return [];

  const speechBlock = voteSpeechTexts
    .map((v) => `${v.voterName}: "${v.speech}"`)
    .join("\n");

  try {
    const request: ChatRequest = {
      model,
      system: [
        "You extract votes from a Mafia game. Players just gave speeches about who they want to hang.",
        "Read each speech and determine who each player is voting to execute.",
        "Reply with ONLY a JSON array: [{\"voter\":\"Name\",\"target\":\"Name\"}, ...]",
        "Omit any voter whose intent is genuinely unclear. Only use names from the candidate list.",
      ].join(" "),
      messages: [{
        role: "user",
        content: `Candidates: ${candidates.join(", ")}\n\nVote speeches:\n${speechBlock}\n\nExtract each voter's target. Reply with ONLY valid JSON.`,
      }],
      temperature: 0,
    };

    let result = "";
    await streamChatResponse(request, (token) => { result += token; }, signal);
    const cleaned = result.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    const votes: MafiaVote[] = [];
    for (const entry of parsed) {
      const voter = voteSpeechTexts.find(
        (v) => v.voterName.toLowerCase() === entry.voter?.toLowerCase()
      );
      const target = candidates.find(
        (c) => c.toLowerCase() === entry.target?.toLowerCase()
      );
      if (voter && target) {
        votes.push({ voterId: "", voterName: voter.voterName, targetName: target });
      }
    }
    return votes;
  } catch { /* parse failed or aborted */ }

  return [];
}

export async function parseWolfKillFromDiscussion(
  wolfMessages: Array<{ wolfName: string; speech: string }>,
  targetNames: string[],
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (wolfMessages.length === 0) return null;

  const discussion = wolfMessages
    .map((m) => `${m.wolfName}: "${m.speech}"`)
    .join("\n");

  try {
    const request: ChatRequest = {
      model,
      system: [
        "You analyze a private wolf discussion in a Mafia game.",
        "Determine their consensus kill target — the player they agreed on, or the one mentioned most favorably as a target.",
        "Reply with ONLY a JSON object: {\"target\":\"Name\"}",
        "Only use names from the target list. If truly unclear: {\"target\":null}",
      ].join(" "),
      messages: [{
        role: "user",
        content: `Targets: ${targetNames.join(", ")}\n\nWolf discussion:\n${discussion}\n\nWho did they decide to kill? Reply with ONLY valid JSON.`,
      }],
      temperature: 0,
    };

    let result = "";
    await streamChatResponse(request, (token) => { result += token; }, signal);
    const cleaned = result.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.target) {
      const match = targetNames.find((n) => n.toLowerCase() === parsed.target.toLowerCase());
      if (match) return match;
    }
  } catch { /* parse failed or aborted */ }

  return null;
}

async function parseNightChoice(
  speech: string,
  candidates: string[],
  action: "protect" | "investigate",
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!speech.trim()) return null;

  try {
    const request: ChatRequest = {
      model,
      system: [
        `You extract a player's night action choice in a Mafia game.`,
        `Determine which player they chose to ${action}.`,
        `Reply with ONLY a JSON object: {"${action}":"Name"}`,
        `Only use names from the candidate list. If unclear: {"${action}":null}`,
      ].join(" "),
      messages: [{
        role: "user",
        content: `Player's response: "${speech}"\nValid candidates: ${candidates.join(", ")}\n\nReply with ONLY valid JSON.`,
      }],
      temperature: 0,
    };

    let result = "";
    await streamChatResponse(request, (token) => { result += token; }, signal);
    const cleaned = result.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const value = parsed[action];
    if (value) {
      const match = candidates.find((n) => n.toLowerCase() === value.toLowerCase());
      if (match) return match;
    }
  } catch { /* parse failed or aborted */ }

  return null;
}

export async function parseNightChoiceWithRetry(
  speech: string,
  candidates: string[],
  action: "protect" | "investigate",
  model: string,
  signal?: AbortSignal,
): Promise<{ name: string; method: "parsed" | "retry" | "random" }> {
  const first = await parseNightChoice(speech, candidates, action, model, signal);
  if (first) return { name: first, method: "parsed" };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const request: ChatRequest = {
        model,
        system: `You MUST respond with exactly one name from this list. Nothing else — just the name.`,
        messages: [{ role: "user", content: `Choose one to ${action}: ${candidates.join(", ")}` }],
        temperature: 0.3,
      };

      let result = "";
      await streamChatResponse(request, (token) => { result += token; }, signal);
      const trimmed = result.trim();

      const parsed = await parseNightChoice(trimmed, candidates, action, model, signal);
      if (parsed) return { name: parsed, method: "retry" };

      const directMatch = candidates.find((c) => trimmed.toLowerCase().includes(c.toLowerCase()));
      if (directMatch) return { name: directMatch, method: "retry" };
    } catch { /* retry failed */ }
  }

  const random = candidates[Math.floor(Math.random() * candidates.length)];
  return { name: random, method: "random" };
}

export async function parseJudgmentVotes(
  speeches: Array<{ voterName: string; speech: string }>,
  accusedName: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ hang: string[]; spare: string[] }> {
  const result = { hang: [] as string[], spare: [] as string[] };
  if (speeches.length === 0) return result;

  const speechBlock = speeches
    .map((v) => `${v.voterName}: "${v.speech}"`)
    .join("\n");

  try {
    const request: ChatRequest = {
      model,
      system: [
        `You extract judgment votes from a Mafia trial. Players voted to HANG or SPARE ${accusedName}.`,
        "Read each speech and determine if the voter wants to hang or spare the accused.",
        'Reply with ONLY a JSON object: {"hang":["Name1","Name2"],"spare":["Name3"]}',
        "Only use voter names from the speeches. If a voter's intent is unclear, put them in spare (benefit of the doubt).",
      ].join(" "),
      messages: [{
        role: "user",
        content: `Trial of ${accusedName}.\n\nVote speeches:\n${speechBlock}\n\nExtract each voter's judgment. Reply with ONLY valid JSON.`,
      }],
      temperature: 0,
    };

    let raw = "";
    await streamChatResponse(request, (token) => { raw += token; }, signal);
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.hang)) result.hang = parsed.hang;
    if (Array.isArray(parsed.spare)) result.spare = parsed.spare;
  } catch { /* parse failed */ }

  return result;
}

export async function orchestrateAccusations(
  messages: MafiaMessage[],
  round: number,
  alivePlayers: MafiaPlayer[],
  model: string,
  signal?: AbortSignal,
): Promise<Array<{ accused: string; accusers: string[]; severity: string }>> {
  const dayMsgs = messages.filter(
    (m) => m.round === round && m.phase === "day" && m.playerId
  );
  if (dayMsgs.length === 0) return [];

  const discussion = dayMsgs.map((m) => `${m.playerName}: ${m.content}`).join("\n");
  const aliveNames = alivePlayers.map((p) => p.name).join(", ");

  try {
    const request: ChatRequest = {
      model,
      system: "You are analyzing a Mafia game discussion to identify accusations. Return only valid JSON, nothing else.",
      messages: [{
        role: "user",
        content: [
          `Alive players: ${aliveNames}`,
          ``,
          `Discussion from Day ${round}:`,
          discussion,
          ``,
          `Identify which LIVING players are being ACCUSED of being a wolf. Only include genuine accusations or expressions of suspicion — not neutral or positive mentions. IGNORE any mentions of dead/eliminated players — they cannot be accused.`,
          `Reply with ONLY a JSON array: [{"accused": "Name", "accusers": ["Name1", "Name2"], "severity": "high"|"medium"|"low"}]`,
          `"high" = direct accusation with evidence/reasoning`,
          `"medium" = expressed suspicion or doubt`,
          `"low" = mild questioning`,
          `If no accusations were made, reply with: []`,
        ].join("\n"),
      }],
      temperature: 0,
    };

    let result = "";
    await streamChatResponse(request, (token) => { result += token; }, signal);
    const cleaned = result.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry: { accused: string; accusers: string[]; severity: string }) => {
        const validAccused = alivePlayers.some((p) => p.name.toLowerCase() === entry.accused?.toLowerCase());
        return validAccused && Array.isArray(entry.accusers) && entry.accusers.length > 0;
      }).map((entry: { accused: string; accusers: string[]; severity: string }) => ({
        ...entry,
        accused: alivePlayers.find((p) => p.name.toLowerCase() === entry.accused.toLowerCase())!.name,
      }));
    }
  } catch { /* analysis failed or aborted */ }

  return [];
}
