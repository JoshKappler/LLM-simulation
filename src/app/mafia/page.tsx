"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { MafiaPlayer, MafiaMessage, MafiaVote, MafiaRole, MafiaRunRecord } from "@/lib/mafia/types";
import { PRESET_PERSONALITIES, pickColor, pickRandomNames, pickRandomPersonalities } from "@/lib/mafia/pools";
import { streamChatResponse } from "@/lib/streamChat";
import { cleanOutput } from "@/lib/cleanOutput";
import type { ChatRequest } from "@/lib/types";
import { W95Slider } from "@/components/W95Slider";
import { fmtDate } from "@/lib/formatDate";

const MESSAGE_WINDOW = 40;
const VOTE_CONTEXT_WINDOW = 20;

// Banned phrases that LLMs overuse — appended to speech prompts
const BANNED_PHRASES = [
  "classic wolf tactic",
  "classic wolf move",
  "classic wolf behavior",
  "classic wolf cover-up",
  "classic wolf lure",
  "concrete evidence",
  "concrete observation",
  "sow division",
  "sowing discord",
  "conveniently",
  "throwing shade",
  "awfully quiet",
  "deflecting suspicion",
  "playing it safe",
  "piggyback",
  "bandwagon",
  "under the bus",
  "speaks volumes",
  "food for thought",
  "interesting that",
  "just saying",
];
const BANNED_PHRASES_LINE = `
SPEAKING RULES:
- Do NOT accuse anyone of "being vague," "lacking concrete evidence," or "not providing observations." Instead, point to a SPECIFIC thing they said and explain why it's suspicious.
- Do NOT use canned phrases like "classic wolf move," "sowing discord," "throwing shade," "speaks volumes," or any similar stock expressions.
- Every accusation must reference something specific someone actually said — quote or paraphrase their words.
- If you can't think of something specific, share your gut feeling about someone rather than criticizing how others argue.`;
const DEFAULT_TEMPERATURE = 0.9;
const MODEL_KEY = "mafia-model";
const TEMP_KEY = "mafia-temperature";

// ── helpers ────────────────────────────────────────────────────────────────────

let msgId = 0;
function nextMsgId() {
  return `mm-${++msgId}`;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}


// ── prompt construction ────────────────────────────────────────────────────────

function buildDayPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  roundHistory?: Array<{
    round: number;
    hangedName: string | null;
    hangedRole: MafiaRole | null;
    nightKillName: string | null;
    nightKillSaved: boolean;
    votes: Array<{ voter: string; target: string }>;
  }>,
  previousSaid?: string[],
  wolfStrategyContent?: string[],
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const dead = allPlayers.filter((p) => !p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");
  const deadInfo = dead.length > 0
    ? `\nEliminated (DEAD — do NOT accuse, discuss, or vote for them): ${dead.map((p) => p.name).join(", ")}`
    : "";

  let roleInfo: string;
  if (player.role === "wolf") {
    const partner = allPlayers.find((p) => p.role === "wolf" && p.id !== player.id && p.alive);
    const partnerInfo = partner ? ` Your fellow wolf is ${partner.name} — protect them without being obvious.` : " You are the last wolf. Be careful.";
    roleInfo = `Your SECRET role: WOLF. You must blend in with the villagers and avoid suspicion. Manipulate, deflect, and cast doubt on others.${partnerInfo} Never reveal you are a wolf.`;
  } else if (player.role === "doctor") {
    roleInfo = "Your SECRET role: DOCTOR. You are a villager with the power to protect one player each night. You must figure out who the wolves are while keeping your role hidden — if wolves learn you're the Doctor, they'll target you.";
  } else if (player.role === "detective") {
    roleInfo = "Your SECRET role: DETECTIVE. You are a villager who can investigate one player each night to learn if they are a wolf. Share your findings carefully — revealing your role makes you a target.";
    if (detectiveResults && detectiveResults.length > 0) {
      const resultLines = detectiveResults.map((r) =>
        `  Night ${r.round}: You investigated ${r.target} — ${r.isWolf ? "WOLF" : "NOT a wolf"}.`
      ).join("\n");

      const foundWolf = detectiveResults.find((r) => r.isWolf);
      const cleared = detectiveResults.filter((r) => !r.isWolf).map((r) => r.target);

      roleInfo += `\n\nYour investigation results:\n${resultLines}`;
      if (foundWolf) {
        roleInfo += `\nYou KNOW ${foundWolf.target} is a wolf. Build a case against them — accuse them with conviction. You can hint at special knowledge without revealing your role, or reveal yourself if the stakes are high enough.`;
      } else if (cleared.length >= 2) {
        roleInfo += `\nYou've cleared ${cleared.join(" and ")}. Steer the group toward untested players. Consider vouching for cleared players if they're under suspicion.`;
      } else {
        roleInfo += `\nUse this information strategically without revealing how you know.`;
      }
    }
  } else {
    roleInfo = "Your SECRET role: VILLAGER. You must figure out who the wolves are and convince others to vote them out. Watch for suspicious behavior — deflection, vagueness, convenient accusations.";
  }

  const recap = roundHistory ? buildRoundRecap(roundHistory) : "";
  const escalation = buildEscalationNote(alive.length, round);
  const noRepeat = previousSaid && previousSaid.length > 0
    ? ` You have already said things like: "${previousSaid.slice(-3).join('"; "')}". Say something NEW — a different observation, a new suspicion, a fresh angle. Do not repeat yourself.`
    : "";

  const textOnly = " This is a text-only discussion — you CANNOT see body language, facial expressions, physical reactions, or locations. Do not reference any physical observations.";
  const knowledgeAnchor = round === 1
    ? `\nThis is the FIRST round. You have never spoken to these people before. You have NO prior observations, no night chat history, no timestamps, no private messages — nothing has happened yet. You can only react to what people say RIGHT NOW in this discussion. Do not reference or invent events from before this moment.${textOnly}`
    : `\nEVERYTHING you know comes from the discussion transcript and round recap above. If it's not there, it didn't happen. No locations, no physical clues, no private conversations exist.${textOnly}`;

  return [
    `You are ${player.name}. You MUST speak in a voice matching this personality — your word choices, sentence structure, emotional tone, and approach should reflect who you are. Do not sound like a generic analyst.`,
    `${player.personality} (Channel this in HOW you speak, not just what you say.)`,
    BANNED_PHRASES_LINE,
    "",
    `You're playing Mafia — a social deduction game. ${alive.length} players remain. Each night, the wolves drag one villager to their death.`,
    `Each round, everyone discusses, then votes to hang one player. If all wolves are hanged, villagers win. If wolves equal villagers, wolves win.`,
    "",
    roleInfo,
    ...(player.role === "wolf" && wolfStrategyContent && wolfStrategyContent.length > 0
      ? ["", `YOUR STRATEGY (from your private wolf discussion this morning):\n${wolfStrategyContent.join("\n")}\nRemember this plan but act natural — don't make it obvious.`]
      : []),
    "",
    `Alive: ${aliveNames}${deadInfo}`,
    ...(recap ? ["", recap] : []),
    "",
    `It is Day ${round}.${knowledgeAnchor} Speak to the group — focus ONLY on living players. Dead players are gone and irrelevant. Stay in character. Be strategic but natural — 2-4 sentences. Don't narrate actions or use asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.${escalation}${noRepeat}`,
  ].join("\n");
}

function buildRebuttalPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  accuserNames: string[],
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = player.role === "wolf"
    ? "Your SECRET role: WOLF. Defend yourself without revealing your true nature. Deflect and cast doubt elsewhere."
    : "Your SECRET role: VILLAGER. Defend yourself honestly and redirect suspicion to whoever seems most suspicious to you.";

  const accuserList = accuserNames.length === 1
    ? accuserNames[0]
    : accuserNames.slice(0, -1).join(", ") + " and " + accuserNames[accuserNames.length - 1];

  return [
    `You are ${player.name}. You MUST speak in a voice matching this personality — your word choices, sentence structure, emotional tone, and approach should reflect who you are.`,
    `${player.personality} (Channel this in HOW you speak, not just what you say.)`,
    BANNED_PHRASES_LINE,
    "",
    `You're playing Mafia. ${alive.length} players remain. Alive: ${aliveNames}`,
    "",
    roleInfo,
    "",
    `Your name has come up multiple times in today's discussion. ${accuserList} seem${accuserNames.length === 1 ? 's' : ''} suspicious of you.`,
    `Address their concerns directly. Defend yourself, challenge your accusers, or redirect suspicion. Be passionate and specific — 2-3 sentences. Don't narrate actions or use asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. Only reference events from the transcript. If you didn't read it above, it didn't happen. This is text-only — no body language, facial expressions, or physical observations.${buildEscalationNote(alive.length, round)}`,
  ].join("\n");
}

function buildFollowUpPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  defendingPlayerName: string,
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = player.role === "wolf"
    ? "Your SECRET role: WOLF. Press your case strategically or back off if pressing draws too much attention to you."
    : "Your SECRET role: VILLAGER. If you still suspect them, press harder. If their defense was convincing, acknowledge it.";

  return [
    `You are ${player.name}. You MUST speak in a voice matching this personality — your word choices, sentence structure, emotional tone, and approach should reflect who you are.`,
    `${player.personality} (Channel this in HOW you speak, not just what you say.)`,
    BANNED_PHRASES_LINE,
    "",
    `You're playing Mafia. ${alive.length} players remain. Alive: ${aliveNames}`,
    "",
    roleInfo,
    "",
    `${defendingPlayerName} just spoke. Respond directly to what they said — challenge their points, defend your position, press harder, or shift focus. Be specific and natural. 2-3 sentences. Don't narrate actions or use asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. This is text-only — no body language, facial expressions, or physical observations.${buildEscalationNote(alive.length, round)}`,
  ].join("\n");
}

function buildVotePrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  roundHistory?: Array<{
    round: number;
    hangedName: string | null;
    hangedRole: MafiaRole | null;
    nightKillName: string | null;
    nightKillSaved: boolean;
    votes: Array<{ voter: string; target: string }>;
  }>,
  round?: number,
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== player.id);
  const dead = allPlayers.filter((p) => !p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleHint = player.role === "wolf"
    ? "As a wolf, vote strategically — condemn a villager or sacrifice a weak wolf to maintain cover."
    : "As a villager, vote for whoever you believe is a wolf.";

  const deadWarning = dead.length > 0
    ? `\nDead players (DO NOT vote for any of these — they are already eliminated): ${dead.map((p) => p.name).join(", ")}`
    : "";

  const recap = roundHistory ? buildRoundRecap(roundHistory) : "";
  const escalation = buildEscalationNote(alive.length + 1, round ?? 1);

  return [
    `You are ${player.name}. You MUST speak in a voice matching this personality — your word choices, sentence structure, emotional tone, and approach should reflect who you are.`,
    `${player.personality} (Channel this in HOW you speak, not just what you say.)`,
    BANNED_PHRASES_LINE,
    "",
    `You can ONLY vote for one of these living players: ${aliveNames}.${deadWarning}`,
    roleHint,
    ...(recap ? ["", recap] : []),
    "",
    `The town is voting to put someone on trial. Base your vote on YOUR OWN reading of the discussion — who struck you as evasive, inconsistent, or suspicious? Name the person YOU find most suspicious and say why, referencing specific things they said or did. 1-2 sentences. No hedging — name one living person clearly. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. Only reference events from the transcript. If you didn't read it above, it didn't happen.${escalation}`,
  ].join("\n");
}

function buildTrialDefensePrompt(
  accused: MafiaPlayer,
  allPlayers: MafiaPlayer[],
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== accused.id);
  const aliveNames = alive.map((p) => p.name).join(", ");

  return [
    `You are ${accused.name}. Your personality influences your style, not your competence.`,
    `${accused.personality}`,
    "",
    `The village has accused you. You are on trial for your life. The remaining players (${aliveNames}) will vote to hang or spare you after you speak.`,
    "",
    `Make your case — defend yourself, deflect suspicion, accuse someone else, plead for mercy. This is your one chance to convince them. 2-3 sentences. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildJudgmentVotePrompt(
  voter: MafiaPlayer,
  accused: MafiaPlayer,
  allPlayers: MafiaPlayer[],
): string {
  const roleHint = voter.role === "wolf"
    ? accused.role === "wolf"
      ? "As a fellow wolf, you probably want to spare them — but voting to spare too eagerly may reveal you."
      : "As a wolf, hanging a villager benefits you."
    : "As a villager, hang them if you think they're a wolf. Spare them if you're not convinced.";

  return [
    `You are ${voter.name}. ${voter.personality}`,
    "",
    `${accused.name} is on trial. You've heard their defense. Now you must vote: HANG or SPARE.`,
    `Judge for yourself based on what you've actually observed — don't just follow the crowd. A wrong hang kills a villager and helps the wolves.`,
    roleHint,
    "",
    `Say your vote clearly — "hang" or "spare" — and briefly explain why, referencing something specific. 1 sentence. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildWolfDiscussionPrompt(
  wolf: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
): string {
  const wolves = allPlayers.filter((p) => p.alive && p.role === "wolf");
  const targets = allPlayers.filter((p) => p.alive && p.role !== "wolf");
  const dead = allPlayers.filter((p) => !p.alive);
  const partnerNames = wolves.filter((w) => w.id !== wolf.id).map((w) => w.name);
  const targetNames = targets.map((p) => p.name).join(", ");

  const partnerLine = partnerNames.length > 0
    ? `You are whispering with your fellow wolf${partnerNames.length > 1 ? 's' : ''}: ${partnerNames.join(" and ")}.`
    : "You are the last wolf. Think through your options.";

  const deadWarning = dead.length > 0
    ? `\nDead players (cannot be targeted): ${dead.map((p) => p.name).join(", ")}`
    : "";

  return [
    `You are ${wolf.name}, a wolf. It is night — the village sleeps.`,
    partnerLine,
    "",
    `Your ONLY valid targets (living villagers): ${targetNames}`,
    `You CANNOT kill fellow wolves or dead players.${deadWarning}`,
    "",
    `Discuss who to kill tonight. Consider who is most dangerous — strong investigators, influential voices, or anyone who suspects you. Name one of the valid targets above. Be strategic and conversational. 1-2 sentences. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildDoctorPrompt(
  doctor: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  lastProtected: string | null,
  roundHistory?: Array<{
    round: number;
    hangedName: string | null;
    hangedRole: MafiaRole | null;
    nightKillName: string | null;
    nightKillSaved: boolean;
    votes: Array<{ voter: string; target: string }>;
  }>,
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const candidates = alive.filter((p) => p.name !== lastProtected);
  const candidateNames = candidates.map((p) => p.name).join(", ");

  const restriction = lastProtected
    ? `\nYou CANNOT protect ${lastProtected} — you protected them last night.`
    : "";

  // Hint about who wolves might target
  const strategyHint = "Wolves tend to kill players who are investigating well, who accused them during the day, or who are leading the village. Think about who stood out today and who the wolves would want silenced.";

  const recap = roundHistory ? buildRoundRecap(roundHistory) : "";

  return [
    `You are ${doctor.name}, the Doctor. It is night. You can protect one player from being killed tonight.`,
    `Players you can protect: ${candidateNames}${restriction}`,
    ...(recap ? ["", recap] : []),
    "",
    strategyHint,
    `Choose wisely — if you protect the wolf's target, they survive. Name exactly one player and say why. 1 sentence. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildDetectivePrompt(
  detective: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  pastResults: Array<{ round: number; target: string; isWolf: boolean }>,
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== detective.id);
  const alreadyInvestigated = new Set(pastResults.map((r) => r.target));
  const candidates = alive.filter((p) => !alreadyInvestigated.has(p.name));
  const candidateNames = candidates.length > 0
    ? candidates.map((p) => p.name).join(", ")
    : alive.map((p) => p.name).join(", ");

  let pastInfo = "";
  if (pastResults.length > 0) {
    pastInfo = "\nYour past investigations:\n" + pastResults.map((r) =>
      `  Night ${r.round}: ${r.target} — ${r.isWolf ? "WOLF" : "NOT a wolf"}`
    ).join("\n") + "\n";
  }

  return [
    `You are ${detective.name}, the Detective. It is night. You MUST investigate one player to learn if they are a wolf.`,
    `Players you can investigate: ${candidateNames}${pastInfo}`,
    `You MUST choose someone — skipping your investigation wastes your most powerful ability. Name exactly one player from the list above and say why you're investigating them. 1 sentence. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildLastWordsPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== player.id);
  const aliveNames = alive.map((p) => p.name).join(", ");

  return [
    `You are ${player.name}. ${player.personality}`,
    "",
    `The village has condemned you. Speak from the heart — not from your archetype. The noose is around your neck — these are your final moments.`,
    `Remaining players: ${aliveNames}`,
    "",
    `Say your last words — share your suspicions, make a final accusation, plead your case, or leave a parting message. 1-2 sentences. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildDeathReactionPrompt(
  reactor: MafiaPlayer,
  deadName: string,
  deadRole: string,
  allPlayers: MafiaPlayer[],
  wasHanging: boolean,
): string {
  const action = wasHanging
    ? `${deadName} was hanged yesterday. They turned out to be a ${deadRole}.`
    : `${deadName} was found dead this morning — killed by wolves in the night. They were a ${deadRole}.`;

  const alive = allPlayers.filter((p) => p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleHint = reactor.role === "wolf"
    ? "As a wolf, react naturally — show fake concern or use this death to cast suspicion elsewhere."
    : "";

  return [
    `You are ${reactor.name}. ${reactor.personality}`,
    BANNED_PHRASES_LINE,
    "",
    action,
    `Remaining players: ${aliveNames}`,
    roleHint,
    "",
    `React to this death — are you shocked, relieved, suspicious, guilty? What does this mean for who the wolves might be? Reference something specific from the game. 1-2 sentences. Be emotional and specific. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. Only reference events from the transcript. If you didn't read it above, it didn't happen. This is text-only — no body language, facial expressions, or physical observations.`,
  ].join("\n");
}

function buildWolfStrategyPrompt(
  wolf: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  roundHistory: Array<{
    round: number;
    hangedName: string | null;
    hangedRole: MafiaRole | null;
    nightKillName: string | null;
    nightKillSaved: boolean;
    votes: Array<{ voter: string; target: string }>;
  }>,
): string {
  const wolves = allPlayers.filter((p) => p.alive && p.role === "wolf");
  const villagers = allPlayers.filter((p) => p.alive && p.role !== "wolf");
  const partnerNames = wolves.filter((w) => w.id !== wolf.id).map((w) => w.name);

  const partnerLine = partnerNames.length > 0
    ? `Whispering with your fellow wolf: ${partnerNames.join(" and ")}.`
    : "You are the last wolf. Plan carefully.";

  const historyNote = roundHistory.length > 0
    ? `\nPast rounds: ${roundHistory.map((h) => {
        const parts: string[] = [];
        if (h.hangedName) parts.push(`D${h.round}: ${h.hangedName} hanged (${h.hangedRole})`);
        if (h.nightKillName) parts.push(`N${h.round}: killed ${h.nightKillName}`);
        return parts.join(", ");
      }).join(" | ")}`
    : "";

  return [
    `You are ${wolf.name}, a wolf. It is dawn — the village is waking up. Quick whisper before day begins.`,
    partnerLine,
    "",
    `Living villagers: ${villagers.map((p) => p.name).join(", ")}${historyNote}`,
    "",
    `Coordinate your daytime strategy: Who should you frame or cast suspicion on today? Who should you defend to look innocent? Should you lay low or be aggressive? Be specific about names. 1-2 sentences. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

function buildInterjectionPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  accusedName: string,
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = player.role === "wolf"
    ? "Your SECRET role: WOLF. Use this moment to steer suspicion away from yourself or your partner."
    : player.role === "detective"
      ? "Your SECRET role: DETECTIVE. Weigh in based on what you know."
      : player.role === "doctor"
        ? "Your SECRET role: DOCTOR. Weigh in honestly."
        : "Your SECRET role: VILLAGER. Weigh in honestly — support the accusation or defend the accused.";

  const urgency = buildEscalationNote(alive.length, round);

  return [
    `You are ${player.name}. Your personality influences your style, not your competence.`,
    `${player.personality}`,
    BANNED_PHRASES_LINE,
    "",
    `You're playing Mafia. ${alive.length} players remain. Alive: ${aliveNames}`,
    "",
    roleInfo,
    "",
    `A heated debate about ${accusedName} is happening. Jump in — do you agree with the accusations? See something others are missing? Have your own suspect?${urgency} 1-2 sentences. Don't narrate actions or use asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. This is text-only — no body language, facial expressions, or physical observations.`,
  ].join("\n");
}

function buildGeneratorPrompt(count: number, existing: string[]): string {
  const existingList = existing.length > 0
    ? `\nDo NOT duplicate these existing personalities:\n${existing.map((p) => `- ${p}`).join("\n")}\n`
    : "";

  return [
    `Generate ${count} unique character personalities for a Mafia/Werewolf social deduction game.`,
    `Each personality should be 1-2 sentences describing HOW this person behaves in group discussions — their social strategy, emotional tendencies, and interpersonal style.`,
    `Make them diverse: include manipulators, truth-seekers, emotional players, analytical minds, wildcards, quiet observers, and loud personalities.`,
    existingList,
    `Reply with ONLY a JSON array of objects: [{"name": "The Archetype", "personality": "description"}, ...]`,
  ].join("\n");
}

// ── round history & escalation helpers ────────────────────────────────────────

function buildRoundRecap(
  history: Array<{
    round: number;
    hangedName: string | null;
    hangedRole: MafiaRole | null;
    nightKillName: string | null;
    nightKillSaved: boolean;
    votes: Array<{ voter: string; target: string }>;
  }>,
): string {
  if (history.length === 0) return "";

  const lines: string[] = ["WHAT HAS HAPPENED:"];
  for (const h of history) {
    if (h.hangedName) {
      const roleLabel = h.hangedRole === "wolf" ? "WOLF!" : h.hangedRole?.toUpperCase() ?? "VILLAGER";
      const wrongNote = h.hangedRole !== "wolf" ? " (wrong call)" : "";
      lines.push(`  Day ${h.round}: ${h.hangedName} was hanged — revealed as ${roleLabel}${wrongNote}`);
    } else {
      lines.push(`  Day ${h.round}: No one was hanged`);
    }
    if (h.votes.length > 0) {
      const voteMap = new Map<string, string[]>();
      for (const v of h.votes) {
        const arr = voteMap.get(v.target) || [];
        arr.push(v.voter);
        voteMap.set(v.target, arr);
      }
      const voteSummary = [...voteMap.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([target, voters]) => `${target}(${voters.length}: ${voters.join(", ")})`)
        .join(", ");
      lines.push(`    Accusation votes: ${voteSummary}`);
    }
    if (h.nightKillSaved) {
      lines.push(`  Night ${h.round}: Wolves attacked but the Doctor saved their target`);
    } else if (h.nightKillName) {
      lines.push(`  Night ${h.round}: ${h.nightKillName} was killed by wolves`);
    }
  }
  return lines.join("\n");
}

function buildEscalationNote(aliveCount: number, round: number): string {
  if (aliveCount <= 4) {
    return `\nURGENT: Only ${aliveCount} players remain. Every vote could end the game. If you suspect someone, this may be your last chance to act.`;
  }
  if (aliveCount <= 6) {
    return `\nThe village is shrinking. ${aliveCount} remain. Wrong votes are increasingly costly.`;
  }
  if (round >= 3) {
    return `\nThis is Day ${round}. The wolves are still out there. Time is not on the village's side.`;
  }
  return "";
}

function formatTrialContext(
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

function formatRecentChat(
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

  // Group messages by phase for structured context
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

function formatWolfContext(messages: MafiaMessage[], round: number): string {
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

// ── LLM orchestrator functions ───────────────────────────────────────────────

async function parseVotesFromSpeech(
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

async function parseWolfKillFromDiscussion(
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

async function parseNightChoiceWithRetry(
  speech: string,
  candidates: string[],
  action: "protect" | "investigate",
  model: string,
  signal?: AbortSignal,
): Promise<{ name: string; method: "parsed" | "retry" | "random" }> {
  // Try parsing the initial speech
  const first = await parseNightChoice(speech, candidates, action, model, signal);
  if (first) return { name: first, method: "parsed" };

  // Retry up to 2x with ultra-constrained prompt
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

      // Try parsing
      const parsed = await parseNightChoice(trimmed, candidates, action, model, signal);
      if (parsed) return { name: parsed, method: "retry" };

      // Try direct string match
      const directMatch = candidates.find((c) => trimmed.toLowerCase().includes(c.toLowerCase()));
      if (directMatch) return { name: directMatch, method: "retry" };
    } catch { /* retry failed */ }
  }

  // All retries failed — random selection
  const random = candidates[Math.floor(Math.random() * candidates.length)];
  return { name: random, method: "random" };
}

async function rewriteInVoice(
  rawSpeech: string,
  playerName: string,
  personality: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!rawSpeech.trim() || rawSpeech === "(stays silent)") return rawSpeech;

  try {
    const request: ChatRequest = {
      model,
      system: [
        "You are a dialogue writer. Rewrite this Mafia game speech to match this character's distinctive voice.",
        `Character: ${playerName}`,
        `Personality: ${personality}`,
        "Keep the same meaning, accusations, and strategic content. Change ONLY the voice: word choices, sentence rhythm, emotional tone, idioms, and mannerisms.",
        "Return ONLY the rewritten speech — no quotes, no commentary, no explanation.",
      ].join("\n"),
      messages: [{ role: "user", content: rawSpeech }],
      temperature: 0.9,
    };

    let result = "";
    await streamChatResponse(request, (token) => { result += token; }, signal);
    const trimmed = result.trim();
    return trimmed || rawSpeech;
  } catch {
    return rawSpeech;
  }
}

async function parseJudgmentVotes(
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

async function orchestrateAccusations(
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
      // Validate names
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

// ── game logic ────────────────────────────────────────────────────────────────

function checkWinCondition(players: MafiaPlayer[]): "villagers" | "wolves" | null {
  const alive = players.filter((p) => p.alive);
  const wolves = alive.filter((p) => p.role === "wolf");
  const villagers = alive.filter((p) => p.role !== "wolf");

  if (wolves.length === 0) return "villagers";
  if (wolves.length >= villagers.length) return "wolves";
  return null;
}

// ── Dialog component ──────────────────────────────────────────────────────────

function Dialog({ title, onClose, children, width }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  return (
    <div className="w95-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w95-dialog" style={{ width: width ?? 600 }}>
        <div className="w95-titlebar">
          <span>{title}</span>
          <div className="w95-winctrls">
            <button className="w95-winbtn" onClick={onClose}>✕</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Transcript Viewer Modal ───────────────────────────────────────────────────

function TranscriptModal({ run, onClose, onBack }: {
  run: MafiaRunRecord; onClose: () => void; onBack: () => void;
}) {
  const [viewTab, setViewTab] = useState<"transcript" | "players">("transcript");
  const [expandedMsgs, setExpandedMsgs] = useState<Set<number>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  const winLabel = run.winner === "villagers"
    ? "Villagers won" : run.winner === "wolves" ? "Wolves won" : "Unfinished";

  function roleLabel(role: MafiaRole): string {
    if (role === "wolf") return "WOLF";
    if (role === "doctor") return "DOCTOR";
    if (role === "detective") return "DETECTIVE";
    return "VILLAGER";
  }

  function roleColor(role: MafiaRole): string {
    if (role === "wolf") return "#cc0000";
    if (role === "doctor") return "#0066aa";
    if (role === "detective") return "#886600";
    return "#006600";
  }

  return (
    <Dialog
      title={`Game — ${fmtDate(run.savedAt)} — ${winLabel}`}
      onClose={onClose}
      width={660}
    >
      <div style={{ display: "flex", borderBottom: "2px solid #808080", background: "#d4d0c8", padding: "4px 8px 0" }}>
        <button
          className="w95-btn"
          style={{ fontSize: 10, marginRight: 8, minWidth: 50, padding: "2px 6px" }}
          onClick={onBack}
        >
          &larr; Back
        </button>
        {(["transcript", "players"] as const).map((t) => (
          <button
            key={t}
            className={`w95-tab ${viewTab === t ? "w95-tab-active" : "w95-tab-inactive"}`}
            style={{ padding: "2px 10px", fontSize: 10 }}
            onClick={() => setViewTab(t)}
          >
            {t === "transcript" ? `Transcript (${run.messages.length})` : `Players (${run.players.length})`}
          </button>
        ))}
      </div>

      {viewTab === "transcript" && (
        <div className="aol-chat w95-scrollable" style={{ height: "60vh", flex: "none" }}>
          {run.messages.map((msg, i) => {
            if (msg.phase === "system") {
              const c = msg.content;
              const cls = c.startsWith("GAME OVER") ? "aol-msg-narrator"
                : c.startsWith("--- DAY") ? "aol-msg-dayheader"
                : c.startsWith("--- NIGHT") ? "aol-msg-nightheader"
                : c.startsWith("--- VOTE") ? "aol-msg-voteheader"
                : c.startsWith("☠") ? "aol-msg-death-kill"
                : c.startsWith("⚖") ? "aol-msg-death-hang"
                : c.startsWith("✚") ? "aol-msg-death-saved"
                : "aol-msg-system";
              return (
                <div key={i} className={`aol-msg ${cls}`}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "vote") {
              const player = run.players.find((p) => p.id === msg.playerId);
              return (
                <div key={i} className="aol-msg aol-msg-vote">
                  {player && <span className="aol-name" style={{ color: player.color }}>{msg.playerName}: </span>}
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "wolf-chat" || msg.phase === "wolf-strategy") {
              const player = run.players.find((p) => p.id === msg.playerId);
              return (
                <div key={i}>
                  <div
                    className="aol-msg aol-msg-wolf"
                    style={{ cursor: msg.systemPrompt ? "pointer" : undefined }}
                    onClick={() => {
                      if (!msg.systemPrompt) return;
                      setExpandedMsgs((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      });
                    }}
                  >
                    <span className="aol-name" style={{ color: player?.color }}>{msg.playerName}: </span>
                    {msg.content}
                    {msg.systemPrompt && (
                      <span style={{ fontSize: 8, color: "#884444", marginLeft: 4 }}>
                        {expandedMsgs.has(i) ? "▼" : "▶"}
                      </span>
                    )}
                  </div>
                  {expandedMsgs.has(i) && msg.systemPrompt && (
                    <pre style={{
                      fontSize: 8, background: "#fffff0", border: "1px solid #c0c0c0",
                      padding: "4px 6px", margin: "0 8px 4px", whiteSpace: "pre-wrap",
                      lineHeight: 1.3, color: "#444", maxHeight: 200, overflowY: "auto",
                    }}>{msg.systemPrompt}</pre>
                  )}
                </div>
              );
            }
            if (msg.phase === "reaction") {
              const player = run.players.find((p) => p.id === msg.playerId);
              const color = player?.color ?? "#000000";
              return (
                <div key={i} className="aol-msg" style={{ background: "#f0f0f0", borderLeft: "3px solid #666666", fontStyle: "italic" }}>
                  <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "doctor") {
              return (
                <div key={i} className="aol-msg" style={{ background: "#e8f4ff", fontStyle: "italic", fontSize: 10, color: "#0066aa" }}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "detective") {
              return (
                <div key={i} className="aol-msg" style={{ background: "#fff8e0", fontStyle: "italic", fontSize: 10, color: "#886600" }}>
                  {msg.content}
                </div>
              );
            }
            // Day speech
            const player = run.players.find((p) => p.id === msg.playerId);
            const color = player?.color ?? "#000000";
            return (
              <div key={i}>
                <div
                  className="aol-msg"
                  style={{
                    background: "#f8f8f8",
                    cursor: msg.systemPrompt ? "pointer" : undefined,
                  }}
                  onClick={() => {
                    if (!msg.systemPrompt) return;
                    setExpandedMsgs((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  }}
                >
                  <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                  {msg.content}
                  {msg.systemPrompt && (
                    <span style={{ fontSize: 8, color: "#808080", marginLeft: 4 }}>
                      {expandedMsgs.has(i) ? "▼" : "▶"}
                    </span>
                  )}
                </div>
                {expandedMsgs.has(i) && msg.systemPrompt && (
                  <pre style={{
                    fontSize: 8, background: "#fffff0", border: "1px solid #c0c0c0",
                    padding: "4px 6px", margin: "0 8px 4px", whiteSpace: "pre-wrap",
                    lineHeight: 1.3, color: "#444", maxHeight: 200, overflowY: "auto",
                  }}>{msg.systemPrompt}</pre>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {viewTab === "players" && (
        <div className="w95-scrollable" style={{ height: "60vh", padding: 8, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 16, fontSize: 9, color: "#555", marginBottom: 8 }}>
            <span>Model: <strong>{run.model}</strong></span>
            <span>Temp: <strong>{run.temperature}</strong></span>
            <span>Rounds: <strong>{run.roundCount}</strong></span>
          </div>
          {run.players.map((p) => (
            <div key={p.id} style={{
              padding: "6px 8px", marginBottom: 4,
              background: p.alive ? "#ffffff" : "#f0f0f0",
              border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              opacity: p.alive ? 1 : 0.6,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: p.color, fontWeight: "bold", fontSize: 12 }}>{p.name}</span>
                <span style={{
                  fontSize: 9, fontWeight: "bold", padding: "1px 4px",
                  background: p.role === "wolf" ? "#ffdddd" : p.role === "doctor" ? "#ddeeff" : p.role === "detective" ? "#fff8dd" : "#ddffdd",
                  color: roleColor(p.role),
                  border: "1px solid",
                  borderColor: roleColor(p.role),
                }}>
                  {roleLabel(p.role)}
                </span>
                {!p.alive && <span style={{ fontSize: 9, color: "#999" }}>(dead)</span>}
              </div>
              <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{p.personality}</div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ── Prompt Viewer Modal ───────────────────────────────────────────────────────

function PromptViewerModal({ players, round, onClose }: {
  players: MafiaPlayer[]; round: number; onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(players.find((p) => p.alive)?.id ?? null);
  const selected = players.find((p) => p.id === selectedId);

  const prompt = selected ? buildDayPrompt(selected, players, round) : "";

  function roleBadge(role: MafiaRole): string {
    if (role === "wolf") return "W";
    if (role === "doctor") return "Dr";
    if (role === "detective") return "Det";
    return "V";
  }

  function roleBadgeColor(role: MafiaRole): string {
    if (role === "wolf") return "#cc0000";
    if (role === "doctor") return "#0066aa";
    if (role === "detective") return "#886600";
    return "#006600";
  }

  return (
    <Dialog title="Player Prompts" onClose={onClose} width={700}>
      <div style={{ display: "flex", height: "60vh" }}>
        <div style={{
          width: 160, borderRight: "2px solid #808080", overflowY: "auto",
          background: "#ffffff",
        }}>
          {players.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              style={{
                padding: "4px 8px", cursor: "pointer", fontSize: 11,
                background: selectedId === p.id ? "#000080" : "transparent",
                color: selectedId === p.id ? "#ffffff" : p.alive ? "#000" : "#999",
                textDecoration: p.alive ? "none" : "line-through",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <span style={{ color: selectedId === p.id ? "#ffffff" : p.color, fontSize: 9 }}>●</span>
              {p.name}
              <span style={{
                fontSize: 8, marginLeft: "auto", fontWeight: "bold",
                color: selectedId === p.id ? "#ffffff" : roleBadgeColor(p.role),
              }}>
                {roleBadge(p.role)}
              </span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8, background: "#ffffff" }}>
          {selected ? (
            <>
              <div style={{ fontSize: 11, fontWeight: "bold", color: selected.color, marginBottom: 4 }}>
                {selected.name} — {selected.role.toUpperCase()}
                {!selected.alive && " (dead)"}
              </div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 8 }}>
                Personality: {selected.personality}
              </div>
              <div style={{ fontSize: 9, fontWeight: "bold", color: "#000080", marginBottom: 2 }}>
                SYSTEM PROMPT (Day {round})
              </div>
              <pre style={{
                fontSize: 9, background: "#fffff0", border: "2px solid",
                borderColor: "#808080 #ffffff #ffffff #808080",
                padding: "6px 8px", whiteSpace: "pre-wrap", lineHeight: 1.4,
                color: "#000", margin: 0,
              }}>{prompt}</pre>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "#808080", padding: 20 }}>Select a player</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ── Stats Modal ──────────────────────────────────────────────────────────────

function StatsModal({ games, onClose }: { games: MafiaRunRecord[]; onClose: () => void }) {
  const total = games.length;
  const wolfWins = games.filter((g) => g.winner === "wolves").length;
  const villagerWins = games.filter((g) => g.winner === "villagers").length;
  const unfinished = games.filter((g) => !g.winner).length;
  const avgRounds = total > 0
    ? (games.reduce((sum, g) => sum + g.roundCount, 0) / total).toFixed(1)
    : "—";

  const modelCounts = new Map<string, number>();
  for (const g of games) {
    modelCounts.set(g.model, (modelCounts.get(g.model) ?? 0) + 1);
  }
  const topModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  return (
    <Dialog title="Game Stats" onClose={onClose} width={340}>
      <div style={{ padding: 12, fontSize: 11 }}>
        {total === 0 ? (
          <div style={{ textAlign: "center", color: "#808080", padding: 20 }}>
            No saved games yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: "bold" }}>Total Games</span>
              <span>{total}</span>
            </div>
            <div style={{
              border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              background: "#ffffff", padding: 8,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#006600", fontWeight: "bold" }}>Villager Wins</span>
                <span>{villagerWins} ({total > 0 ? Math.round(villagerWins / total * 100) : 0}%)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#cc0000", fontWeight: "bold" }}>Wolf Wins</span>
                <span>{wolfWins} ({total > 0 ? Math.round(wolfWins / total * 100) : 0}%)</span>
              </div>
              {unfinished > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#808080" }}>Unfinished</span>
                  <span>{unfinished}</span>
                </div>
              )}
              {/* Win rate bar */}
              {(wolfWins + villagerWins) > 0 && (
                <div style={{
                  marginTop: 6, height: 12, display: "flex",
                  border: "1px solid #808080", overflow: "hidden",
                }}>
                  <div style={{
                    width: `${villagerWins / (wolfWins + villagerWins) * 100}%`,
                    background: "#006600",
                  }} />
                  <div style={{
                    width: `${wolfWins / (wolfWins + villagerWins) * 100}%`,
                    background: "#cc0000",
                  }} />
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: "bold" }}>Avg Rounds</span>
              <span>{avgRounds}</span>
            </div>
            {topModel && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: "bold" }}>Top Model</span>
                <span style={{ fontSize: 9 }}>{topModel[0]} ({topModel[1]})</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

export default function MafiaPage() {
  // ── state ──
  const [players, setPlayers] = useState<MafiaPlayer[]>([]);
  const [messages, setMessages] = useState<MafiaMessage[]>([]);
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<"setup" | "day" | "vote" | "night" | "ended">("setup");
  const [winner, setWinner] = useState<"villagers" | "wolves" | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);

  // Config
  const [playerCount, setPlayerCount] = useState(10);
  const [wolfCount, setWolfCount] = useState(2);
  const [maxRounds, setMaxRounds] = useState(8);
  const [temperature, setTemperature] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_TEMPERATURE;
    const stored = localStorage.getItem(TEMP_KEY);
    return stored ? parseFloat(stored) : DEFAULT_TEMPERATURE;
  });
  const [model, setModel] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(MODEL_KEY) ?? "";
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Personality customization
  const [usePresets, setUsePresets] = useState(true);
  const [customPersonalities, setCustomPersonalities] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [personalityRewrite, setPersonalityRewrite] = useState(true);

  // Pre-game player editing
  const [previewPlayers, setPreviewPlayers] = useState<Array<{ name: string; personality: string }>>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editPersonality, setEditPersonality] = useState("");

  // Modals
  const [showPastGames, setShowPastGames] = useState(false);
  const [viewingRun, setViewingRun] = useState<MafiaRunRecord | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [pastGames, setPastGames] = useState<MafiaRunRecord[]>([]);

  // ── refs ──
  const stopFlagRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const playersRef = useRef<MafiaPlayer[]>([]);
  const messagesRef = useRef<MafiaMessage[]>([]);
  const roundRef = useRef(0);
  const modelRef = useRef("");
  const temperatureRef = useRef(DEFAULT_TEMPERATURE);
  const maxRoundsRef = useRef(8);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const winnerRef = useRef<"villagers" | "wolves" | null>(null);
  const lastProtectedRef = useRef<string | null>(null);
  const detectiveResultsRef = useRef<Array<{ round: number; target: string; isWolf: boolean }>>([]);
  const roundHistoryRef = useRef<Array<{
    round: number;
    hangedName: string | null;
    hangedRole: MafiaRole | null;
    nightKillName: string | null;
    nightKillSaved: boolean;
    votes: Array<{ voter: string; target: string }>;
  }>>([]);
  const playerSaidRef = useRef<Map<string, string[]>>(new Map());
  const personalityRewriteRef = useRef(true);

  // ── sync refs ──
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { roundRef.current = round; }, [round]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { temperatureRef.current = temperature; }, [temperature]);
  useEffect(() => { maxRoundsRef.current = maxRounds; }, [maxRounds]);
  useEffect(() => { winnerRef.current = winner; }, [winner]);
  useEffect(() => { personalityRewriteRef.current = personalityRewrite; }, [personalityRewrite]);


  // Clamp wolf count: wolves must be strictly fewer than non-wolves
  useEffect(() => {
    const maxW = Math.max(1, Math.floor((playerCount - 1) / 2));
    if (wolfCount > maxW) setWolfCount(maxW);
  }, [playerCount, wolfCount]);

  // ── auto-scroll ──
  useEffect(() => {
    if (isAtBottomRef.current) {
      chatContainerRef.current?.scrollTo({ top: chatContainerRef.current.scrollHeight });
    }
  }, [messages]);

  // ── fetch models ──
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models: string[] }) => {
        setAvailableModels(data.models ?? []);
        if (!model && data.models?.length) {
          setModel(data.models[0]);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── persist settings ──
  useEffect(() => { if (model) localStorage.setItem(MODEL_KEY, model); }, [model]);
  useEffect(() => { localStorage.setItem(TEMP_KEY, String(temperature)); }, [temperature]);

  // ── saved runs ──

  const loadPastGames = useCallback(() => {
    fetch("/api/mafia-runs")
      .then((r) => r.json())
      .then((data) => setPastGames(data.runs ?? []))
      .catch(() => setPastGames([]));
  }, []);

  const saveGame = useCallback((w: "villagers" | "wolves" | null) => {
    try {
      const record: MafiaRunRecord = {
        id: Date.now().toString(),
        savedAt: new Date().toISOString(),
        players: playersRef.current,
        messages: messagesRef.current,
        winner: w,
        roundCount: roundRef.current,
        model: modelRef.current,
        temperature: temperatureRef.current,
      };
      fetch("/api/mafia-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }).catch((err) => console.error("Failed to save game to disk:", err));
    } catch (err) {
      console.error("Failed to save game:", err);
    }
  }, []);

  const deleteGame = useCallback((id: string) => {
    fetch(`/api/mafia-runs/${id}`, { method: "DELETE" })
      .then(() => setPastGames((prev) => prev.filter((r) => r.id !== id)))
      .catch(() => {});
  }, []);

  // ── message helpers ──

  const addMessage = useCallback((msg: Omit<MafiaMessage, "id">) => {
    const full = { ...msg, id: nextMsgId() };
    setMessages((prev) => [...prev, full]);
    messagesRef.current = [...messagesRef.current, full];
    return full.id;
  }, []);

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
    messagesRef.current = messagesRef.current.map((m) => m.id === id ? { ...m, content } : m);
  }, []);

  // ── generate personalities via LLM ──

  const generatePersonalities = useCallback(async () => {
    if (!model) return;
    setIsGenerating(true);
    try {
      const existing = customPersonalities.concat(PRESET_PERSONALITIES.map((p) => p.personality));
      const prompt = buildGeneratorPrompt(playerCount, existing);
      const request: ChatRequest = {
        model,
        system: "You are a creative character designer. Reply with valid JSON only.",
        messages: [{ role: "user", content: prompt }],
        temperature: 1.0,
        numPredict: 2000,
      };
      let full = "";
      await streamChatResponse(request, (token) => { full += token; });

      const cleaned = full.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned) as Array<{ name: string; personality: string }>;
      setCustomPersonalities(parsed.map((p) => p.personality));
      setUsePresets(false);
    } catch (err) {
      console.error("Failed to generate personalities:", err);
    }
    setIsGenerating(false);
  }, [model, playerCount, customPersonalities]);

  // ── speech generation helper ──

  const generateSpeech = useCallback(async (
    systemPrompt: string,
    contextMsg: string,
    speaker: MafiaPlayer,
    currentRound: number,
    phaseType: MafiaMessage["phase"],
    temp?: number,
  ): Promise<string> => {
    const request: ChatRequest = {
      model: modelRef.current,
      system: systemPrompt,
      messages: [{ role: "user", content: contextMsg }],
      temperature: temp ?? temperatureRef.current,
    };

    const placeholderId = addMessage({
      round: currentRound,
      phase: phaseType,
      playerId: speaker.id,
      playerName: speaker.name,
      content: "",
      systemPrompt,
    });
    setStreamingMsgId(placeholderId);

    let streamedSoFar = "";
    let fullText = "";
    try {
      fullText = await streamChatResponse(request, (token) => {
        streamedSoFar += token;
        updateMessage(placeholderId, streamedSoFar);
      }, abortRef.current?.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        updateMessage(placeholderId, streamedSoFar || "(stopped)");
        setStreamingMsgId(null);
        return "";
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMessage(placeholderId, `[error: ${errMsg}]`);
      setStreamingMsgId(null);
      return "";
    }

    const allPlayerNames = playersRef.current.map((p) => p.name);
    let cleaned = cleanOutput(fullText, speaker.name, allPlayerNames);
    if (!cleaned.trim()) {
      cleaned = "(stays silent)";
    }

    // Voice rewrite pass — rewrite in the player's distinctive voice
    if (personalityRewriteRef.current && cleaned !== "(stays silent)" && speaker.personality) {
      updateMessage(placeholderId, cleaned + " ...");
      cleaned = await rewriteInVoice(cleaned, speaker.name, speaker.personality, modelRef.current, abortRef.current?.signal);
    }

    updateMessage(placeholderId, cleaned);
    setStreamingMsgId(null);
    return cleaned;
  }, [addMessage, updateMessage]);

  // ── day phase: one player speaks ──

  const runDaySpeech = useCallback(async (speaker: MafiaPlayer, currentRound: number) => {
    const detResults = speaker.role === "detective" ? detectiveResultsRef.current : undefined;
    const previousSaid = playerSaidRef.current.get(speaker.id);

    // Extract wolf strategy messages for this round so wolves can follow their plan
    let wolfStrategy: string[] | undefined;
    if (speaker.role === "wolf") {
      wolfStrategy = messagesRef.current
        .filter((m) => m.round === currentRound && m.phase === "wolf-strategy" && m.playerId)
        .map((m) => `${m.playerName}: ${m.content}`)
        .filter((s) => s.length > 0);
      if (wolfStrategy.length === 0) wolfStrategy = undefined;
    }

    const system = buildDayPrompt(speaker, playersRef.current, currentRound, detResults, roundHistoryRef.current, previousSaid, wolfStrategy);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    const speech = await generateSpeech(system, recentChat, speaker, currentRound, "day");
    // Track what this player said (for no-repeat)
    if (speech && speech !== "(stays silent)") {
      const existing = playerSaidRef.current.get(speaker.id) || [];
      existing.push(speech.slice(0, 60));
      playerSaidRef.current.set(speaker.id, existing);
    }
  }, [generateSpeech]);

  // ── rebuttal: accused player defends ──

  const runRebuttalSpeech = useCallback(async (
    speaker: MafiaPlayer,
    currentRound: number,
    accuserNames: string[],
  ) => {
    const system = buildRebuttalPrompt(speaker, playersRef.current, currentRound, accuserNames);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    await generateSpeech(system, recentChat, speaker, currentRound, "day");
  }, [generateSpeech]);

  // ── follow-up: accuser responds to defense ──

  const runFollowUpSpeech = useCallback(async (
    speaker: MafiaPlayer,
    currentRound: number,
    defendingPlayerName: string,
  ) => {
    const system = buildFollowUpPrompt(speaker, playersRef.current, currentRound, defendingPlayerName);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    await generateSpeech(system, recentChat, speaker, currentRound, "day");
  }, [generateSpeech]);

  // ── last words: hanged player's final speech ──

  const runLastWords = useCallback(async (speaker: MafiaPlayer, currentRound: number) => {
    const system = buildLastWordsPrompt(speaker, playersRef.current);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    await generateSpeech(system, recentChat, speaker, currentRound, "day");
  }, [generateSpeech]);

  // ── wolf discussion ──

  const runWolfChat = useCallback(async (wolf: MafiaPlayer, currentRound: number) => {
    const system = buildWolfDiscussionPrompt(wolf, playersRef.current, currentRound);
    const context = formatWolfContext(messagesRef.current, currentRound);
    await generateSpeech(system, context, wolf, currentRound, "wolf-chat", 0.8);
  }, [generateSpeech]);

  // ── vote phase (two-stage trial system) ──

  const runVotePhase = useCallback(async (currentRound: number): Promise<{ hanged: MafiaPlayer | null; votes: MafiaVote[] }> => {
    setPhase("vote");
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `--- VOTE ${currentRound} --- The town must decide who to put on trial.`,
    });

    // ── STAGE 1: Accusation vote — who goes on trial? ──

    const alive = playersRef.current.filter((p) => p.alive);
    const speakOrder = shuffle(alive);
    const voteSpeechTexts: Array<{ voterName: string; voterId: string; speech: string }> = [];

    // Freeze context ONCE so later voters can't see earlier voters' speeches
    const frozenVoteContext = formatRecentChat(messagesRef.current, VOTE_CONTEXT_WINDOW, false, playersRef.current);

    for (const voter of speakOrder) {
      if (stopFlagRef.current) return { hanged: null, votes: [] };

      setStatusMsg(`${voter.name} names their suspect...`);
      const system = buildVotePrompt(voter, playersRef.current, roundHistoryRef.current, currentRound);
      let speech = await generateSpeech(system, frozenVoteContext, voter, currentRound, "vote");

      if (!speech || speech === "(stays silent)") {
        speech = await generateSpeech(
          `You are ${voter.name}. You MUST accuse someone. Name one living person and say why. 1 sentence. No reasoning, no thinking tags.`,
          frozenVoteContext, voter, currentRound, "vote",
        );
      }

      voteSpeechTexts.push({ voterName: voter.name, voterId: voter.id, speech });
    }

    if (stopFlagRef.current) return { hanged: null, votes: [] };

    const validSpeeches = voteSpeechTexts.filter((s) => s.speech && s.speech !== "(stays silent)");
    const candidates = alive.map((p) => p.name);

    if (validSpeeches.length === 0) {
      addMessage({ round: currentRound, phase: "system", playerName: "System", content: "No one spoke. No one is put on trial today." });
      return { hanged: null, votes: [] };
    }

    setStatusMsg("Counting accusations...");
    const votes = await parseVotesFromSpeech(validSpeeches, candidates, modelRef.current, abortRef.current?.signal);

    for (const v of votes) {
      const match = voteSpeechTexts.find((s) => s.voterName === v.voterName);
      if (match) v.voterId = match.voterId;
    }

    // Tally accusation votes
    const tally = new Map<string, string[]>();
    for (const v of votes) {
      const existing = tally.get(v.targetName) ?? [];
      existing.push(v.voterName);
      tally.set(v.targetName, existing);
    }

    if (tally.size > 0) {
      const tallyParts = [...tally.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, voters]) => `${name} (${voters.length}) — ${voters.join(", ")}`);
      const noVoters = alive.filter((p) => !votes.some((v) => v.voterId === p.id)).map((p) => p.name);
      let tallyMsg = `Accusation tally: ${tallyParts.join(" | ")}`;
      if (noVoters.length > 0) tallyMsg += ` | Abstained: ${noVoters.join(", ")}`;
      addMessage({ round: currentRound, phase: "system", playerName: "System", content: tallyMsg });
    }

    const voteCounts = new Map<string, number>();
    for (const v of votes) {
      voteCounts.set(v.targetName, (voteCounts.get(v.targetName) ?? 0) + 1);
    }

    const maxVotes = Math.max(...voteCounts.values(), 0);
    if (maxVotes === 0) {
      addMessage({ round: currentRound, phase: "system", playerName: "System", content: "No valid accusations. No one is put on trial today." });
      return { hanged: null, votes };
    }

    // Tiebreak: random among tied
    const tied = [...voteCounts.entries()].filter(([, c]) => c === maxVotes).map(([n]) => n);
    const accusedName = tied[Math.floor(Math.random() * tied.length)];
    const accused = playersRef.current.find((p) => p.name === accusedName && p.alive);

    if (!accused) return { hanged: null, votes };

    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `${accused.name} is put on trial! They will now make their defense.`,
    });

    // ── STAGE 2: Trial defense — accused makes their case ──

    if (!stopFlagRef.current) {
      setStatusMsg(`${accused.name} defends themselves at trial...`);
      const defenseSystem = buildTrialDefensePrompt(accused, playersRef.current);
      const defenseContext = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
      await generateSpeech(defenseSystem, defenseContext, accused, currentRound, "vote");
    }

    if (stopFlagRef.current) return { hanged: null, votes };

    // ── STAGE 3: Judgment vote — hang or spare? ──

    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `The village votes: HANG or SPARE ${accused.name}?`,
    });

    const jurors = alive.filter((p) => p.id !== accused.id);
    const judgmentOrder = shuffle(jurors);
    const judgmentSpeeches: Array<{ voterName: string; speech: string }> = [];

    // Freeze trial context ONCE so later jurors can't see earlier jurors' votes
    const frozenTrialContext = formatTrialContext(messagesRef.current, currentRound, accused.name);

    for (const juror of judgmentOrder) {
      if (stopFlagRef.current) return { hanged: null, votes };

      setStatusMsg(`${juror.name} votes on ${accused.name}'s fate...`);
      const system = buildJudgmentVotePrompt(juror, accused, playersRef.current);
      const speech = await generateSpeech(system, frozenTrialContext, juror, currentRound, "vote");
      judgmentSpeeches.push({ voterName: juror.name, speech });
    }

    if (stopFlagRef.current) return { hanged: null, votes };

    // Parse hang/spare votes
    setStatusMsg("Counting judgment votes...");
    const judgment = await parseJudgmentVotes(judgmentSpeeches, accused.name, modelRef.current, abortRef.current?.signal);

    const hangCount = judgment.hang.length;
    const spareCount = judgment.spare.length;
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `Judgment: HANG (${hangCount}) — ${judgment.hang.join(", ") || "none"} | SPARE (${spareCount}) — ${judgment.spare.join(", ") || "none"}`,
    });

    // Majority needed to hang
    if (hangCount <= spareCount) {
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: `The village spares ${accused.name}. No one hangs today.`,
      });
      return { hanged: null, votes };
    }

    // ── STAGE 4: Last words, then execution ──

    if (!stopFlagRef.current) {
      setStatusMsg(`${accused.name} speaks their last words...`);
      await runLastWords(accused, currentRound);
    }

    const roleReveal = accused.role === "wolf" ? "They were a WOLF!"
      : accused.role === "doctor" ? "They were the DOCTOR."
      : accused.role === "detective" ? "They were the DETECTIVE."
      : "They were a villager.";
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `⚖ ${accused.name} is dragged to the gallows and hanged (${hangCount}-${spareCount}). ${roleReveal}`,
    });

    const updated = playersRef.current.map((p) =>
      p.id === accused.id ? { ...p, alive: false } : p
    );
    setPlayers(updated);
    playersRef.current = updated;

    return { hanged: accused, votes };
  }, [addMessage, generateSpeech, runLastWords]);

  // ── night phase ──

  const runNightPhase = useCallback(async (currentRound: number): Promise<{ victim: MafiaPlayer | null; saved: boolean }> => {
    setPhase("night");
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: "--- NIGHT --- The town sleeps. Wolves gather in the shadows...",
    });

    const wolves = playersRef.current.filter((p) => p.alive && p.role === "wolf");
    const targets = playersRef.current.filter((p) => p.alive && p.role !== "wolf");

    if (wolves.length === 0 || targets.length === 0) return { victim: null, saved: false };

    // Wolf discussion — always run (solo wolf thinks aloud, 2+ wolves confer)
    const discussRounds = 1;
    for (let discussRound = 0; discussRound < discussRounds; discussRound++) {
      for (const wolf of wolves) {
        if (stopFlagRef.current) return { victim: null, saved: false };
        setStatusMsg(`${wolf.name} is plotting...`);
        await runWolfChat(wolf, currentRound);
      }
    }

    if (stopFlagRef.current) return { victim: null, saved: false };

    // Parse kill target from wolf discussion
    const targetNames = targets.map((p) => p.name);
    const wolfChatMsgs = messagesRef.current
      .filter((m) => m.round === currentRound && m.phase === "wolf-chat" && m.playerId)
      .map((m) => ({ wolfName: m.playerName, speech: m.content }))
      .filter((m) => m.speech && m.speech !== "(stays silent)");

    setStatusMsg("Wolves choose their victim...");

    // If wolves stayed silent, pick a random target
    let wolfTargetName: string | null;
    if (wolfChatMsgs.length === 0) {
      wolfTargetName = targetNames[Math.floor(Math.random() * targetNames.length)];
    } else {
      wolfTargetName = await parseWolfKillFromDiscussion(wolfChatMsgs, targetNames, modelRef.current, abortRef.current?.signal);
    }

    // Fallback: if parser failed, pick random target (wolves always kill)
    if (!wolfTargetName) {
      wolfTargetName = targetNames[Math.floor(Math.random() * targetNames.length)];
    }

    if (stopFlagRef.current) return { victim: null, saved: false };

    // Doctor protection
    let protectedName: string | null = null;
    const doctor = playersRef.current.find((p) => p.alive && p.role === "doctor");
    if (doctor) {
      setStatusMsg(`${doctor.name} chooses who to protect...`);
      const doctorSystem = buildDoctorPrompt(doctor, playersRef.current, lastProtectedRef.current, roundHistoryRef.current);
      const doctorRequest: ChatRequest = {
        model: modelRef.current,
        system: doctorSystem,
        messages: [{ role: "user", content: formatRecentChat(messagesRef.current, MESSAGE_WINDOW) }],
        temperature: 0.3,
      };

      let doctorResponse = "";
      try {
        doctorResponse = await streamChatResponse(doctorRequest, () => {}, abortRef.current?.signal);
      } catch {
        doctorResponse = "";
      }

      const validTargets = playersRef.current
        .filter((p) => p.alive && p.name !== lastProtectedRef.current)
        .map((p) => p.name);

      const doctorChoice = await parseNightChoiceWithRetry(doctorResponse, validTargets, "protect", modelRef.current, abortRef.current?.signal);
      protectedName = doctorChoice.name;
      lastProtectedRef.current = protectedName;

      const methodNote = doctorChoice.method !== "parsed" ? ` (${doctorChoice.method})` : "";
      addMessage({
        round: currentRound,
        phase: "doctor",
        playerId: doctor.id,
        playerName: doctor.name,
        content: `The Doctor chose to protect ${protectedName} tonight.${methodNote}`,
      });
    }

    // Detective investigation
    const detective = playersRef.current.find((p) => p.alive && p.role === "detective");
    if (detective && !stopFlagRef.current) {
      setStatusMsg(`${detective.name} investigates...`);
      const detSystem = buildDetectivePrompt(detective, playersRef.current, detectiveResultsRef.current);
      const detRequest: ChatRequest = {
        model: modelRef.current,
        system: detSystem,
        messages: [{ role: "user", content: formatRecentChat(messagesRef.current, MESSAGE_WINDOW) }],
        temperature: 0.3,
      };

      let detResponse = "";
      try {
        detResponse = await streamChatResponse(detRequest, () => {}, abortRef.current?.signal);
      } catch {
        detResponse = "";
      }

      const detCandidates = playersRef.current
        .filter((p) => p.alive && p.id !== detective.id)
        .map((p) => p.name);

      const detChoice = await parseNightChoiceWithRetry(detResponse, detCandidates, "investigate", modelRef.current, abortRef.current?.signal);
      const investigatedName = detChoice.name;
      const investigatedPlayer = playersRef.current.find((p) => p.name === investigatedName);
      const isWolf = investigatedPlayer?.role === "wolf";
      detectiveResultsRef.current = [...detectiveResultsRef.current, { round: currentRound, target: investigatedName, isWolf }];

      const detMethodNote = detChoice.method !== "parsed" ? ` (${detChoice.method})` : "";
      addMessage({
        round: currentRound,
        phase: "detective",
        playerId: detective.id,
        playerName: detective.name,
        content: `The Detective investigated ${investigatedName} — ${isWolf ? "they ARE a wolf!" : "they are NOT a wolf."}${detMethodNote}`,
      });
    }

    if (stopFlagRef.current) return { victim: null, saved: false };

    // Resolve night kill
    const victim = playersRef.current.find((p) => p.name === wolfTargetName && p.alive);

    if (victim) {
      if (protectedName === victim.name) {
        addMessage({
          round: currentRound,
          phase: "system",
          playerName: "System",
          content: `✚ Dawn breaks. The wolves targeted ${victim.name}, but the Doctor saved them! Everyone survived the night.`,
        });
        return { victim: null, saved: true };
      }

      const updated = playersRef.current.map((p) =>
        p.id === victim.id ? { ...p, alive: false } : p
      );
      setPlayers(updated);
      playersRef.current = updated;

      const roleReveal = victim.role === "doctor" ? "doctor"
        : victim.role === "detective" ? "detective"
        : victim.role;
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: `☠ Dawn breaks. ${victim.name} was found dead — murdered by the wolves. They were a ${roleReveal}.`,
      });
    }

    return { victim: victim ?? null, saved: false };
  }, [addMessage, runWolfChat]);

  // ── main game loop ──

  const runGame = useCallback(async () => {
    let currentRound = 1;
    roundRef.current = 1;
    setRound(1);
    let gameWinner: "villagers" | "wolves" | null = null;

    try {
    while (!stopFlagRef.current) {
      if (currentRound > maxRoundsRef.current) {
        addMessage({
          round: currentRound,
          phase: "system",
          playerName: "System",
          content: "Maximum rounds reached. The wolves have outlasted the village!",
        });
        gameWinner = "wolves";
        setWinner("wolves");
        break;
      }

      // ── DAY PHASE ──
      setPhase("day");
      const aliveNowForHeader = playersRef.current.filter((p) => p.alive);
      const aliveNames = aliveNowForHeader.map((p) => p.name).join(", ");
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: `--- DAY ${currentRound} ---\nAlive (${aliveNowForHeader.length}): ${aliveNames}`,
      });

      // ── MORNING DEATH REACTIONS (round 2+) ──
      if (currentRound > 1 && roundHistoryRef.current.length > 0) {
        const lastHistory = roundHistoryRef.current[roundHistoryRef.current.length - 1];
        const deathsToReactTo: Array<{ name: string; role: string; wasHanging: boolean }> = [];

        if (lastHistory.nightKillName && !lastHistory.nightKillSaved) {
          const victim = playersRef.current.find((p) => p.name === lastHistory.nightKillName);
          deathsToReactTo.push({ name: lastHistory.nightKillName, role: victim?.role || "villager", wasHanging: false });
        }
        if (lastHistory.hangedName && lastHistory.hangedRole) {
          deathsToReactTo.push({ name: lastHistory.hangedName, role: lastHistory.hangedRole, wasHanging: true });
        }

        if (deathsToReactTo.length > 0) {
          const aliveNow = playersRef.current.filter((p) => p.alive);
          const reactorCount = aliveNow.length <= 5 ? 1 : 2;
          const reactors = shuffle(aliveNow).slice(0, Math.min(reactorCount, aliveNow.length));
          const primaryDeath = deathsToReactTo[0]; // night kill is most dramatic

          for (const reactor of reactors) {
            if (stopFlagRef.current) break;
            setStatusMsg(`${reactor.name} reacts to ${primaryDeath.name}'s death...`);
            const system = buildDeathReactionPrompt(reactor, primaryDeath.name, primaryDeath.role, playersRef.current, primaryDeath.wasHanging);
            await generateSpeech(system, "(React to the news.)", reactor, currentRound, "reaction");
          }
        }
      }

      if (stopFlagRef.current) break;

      // ── WOLF PRE-DAY STRATEGY WHISPER (round 2+) ──
      if (currentRound > 1) {
        const wolves = playersRef.current.filter((p) => p.alive && p.role === "wolf");
        if (wolves.length > 0) {
          for (const wolf of wolves) {
            if (stopFlagRef.current) break;
            setStatusMsg(`${wolf.name} strategizes...`);
            const system = buildWolfStrategyPrompt(wolf, playersRef.current, currentRound, roundHistoryRef.current);
            const lastKill = roundHistoryRef.current.length > 0
              ? roundHistoryRef.current[roundHistoryRef.current.length - 1].nightKillName
              : null;
            const context = lastKill
              ? `Last night you killed ${lastKill}. Plan your day.`
              : "Plan your day strategy.";
            await generateSpeech(system, context, wolf, currentRound, "wolf-strategy", 0.8);
          }
        }
      }

      if (stopFlagRef.current) break;

      const alive = playersRef.current.filter((p) => p.alive);
      const speakOrder = shuffle(alive);

      // Everyone speaks once
      for (const speaker of speakOrder) {
        if (stopFlagRef.current) break;
        setStatusMsg(`${speaker.name} is speaking...`);
        await runDaySpeech(speaker, currentRound);
        if (stopFlagRef.current) break;
      }

      if (stopFlagRef.current) break;

      // LLM-based accusation detection
      setStatusMsg("Analyzing accusations...");
      const accusations = await orchestrateAccusations(
        messagesRef.current,
        currentRound,
        playersRef.current.filter((p) => p.alive),
        modelRef.current,
        abortRef.current?.signal,
      );

      // Filter to high/medium severity
      const significant = accusations.filter((a) => a.severity === "high" || a.severity === "medium");

      if (significant.length > 0 && !stopFlagRef.current) {
        const top = significant[0];
        const topPlayer = playersRef.current.find((p) => p.name === top.accused && p.alive);

        if (topPlayer) {
          // Accused defends → main accuser responds (kept tight: 2 messages)
          setStatusMsg(`${topPlayer.name} defends themselves...`);
          await runRebuttalSpeech(topPlayer, currentRound, top.accusers);
          if (stopFlagRef.current) break;

          const mainAccuser = playersRef.current.find(
            (p) => p.name === top.accusers[0] && p.alive
          );
          if (mainAccuser && !stopFlagRef.current) {
            setStatusMsg(`${mainAccuser.name} responds...`);
            await runFollowUpSpeech(mainAccuser, currentRound, topPlayer.name);
            if (stopFlagRef.current) break;
          }
        }
      }

      if (stopFlagRef.current) break;

      // ── VOTE PHASE ──
      setStatusMsg("Voting...");
      const voteResult = await runVotePhase(currentRound);
      if (stopFlagRef.current) break;

      const winAfterVote = checkWinCondition(playersRef.current);
      if (winAfterVote) {
        gameWinner = winAfterVote;
        setWinner(winAfterVote);
        break;
      }

      // ── NIGHT PHASE ──
      setStatusMsg("Night falls...");
      const nightResult = await runNightPhase(currentRound);
      if (stopFlagRef.current) break;

      // ── RECORD ROUND HISTORY ──
      roundHistoryRef.current.push({
        round: currentRound,
        hangedName: voteResult.hanged?.name ?? null,
        hangedRole: voteResult.hanged?.role ?? null,
        nightKillName: nightResult.victim?.name ?? null,
        nightKillSaved: nightResult.saved,
        votes: voteResult.votes.map((v) => ({ voter: v.voterName, target: v.targetName })),
      });

      const winAfterNight = checkWinCondition(playersRef.current);
      if (winAfterNight) {
        gameWinner = winAfterNight;
        setWinner(winAfterNight);
        break;
      }

      currentRound++;
      setRound(currentRound);
      roundRef.current = currentRound;
    }

    // Finalize
    if (!stopFlagRef.current && gameWinner) {
      setPhase("ended");
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: gameWinner === "villagers"
          ? "GAME OVER: The villagers have found and hanged every last wolf!"
          : "GAME OVER: The wolves have taken over the village!",
      });
    }
    } catch (err) {
      // AbortError is expected when stop is pressed — swallow it
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.error("[mafia] game loop error:", err);
      }
    }

    // Auto-save
    const finalWinner = gameWinner ?? checkWinCondition(playersRef.current);
    saveGame(finalWinner);

    setIsRunning(false);
    setStatusMsg(stopFlagRef.current ? "Stopped" : "Game Over");
  }, [addMessage, generateSpeech, runDaySpeech, runRebuttalSpeech, runFollowUpSpeech, runVotePhase, runNightPhase, saveGame]);

  // ── controls ──

  const generatePreviewPlayers = useCallback(() => {
    const names = pickRandomNames(playerCount);
    const personalities = usePresets
      ? pickRandomPersonalities(playerCount)
      : customPersonalities.length >= playerCount
        ? shuffle(customPersonalities).slice(0, playerCount)
        : pickRandomPersonalities(playerCount);

    setPreviewPlayers(names.map((name, i) => ({
      name,
      personality: personalities[i],
    })));
    setEditingIdx(null);
  }, [playerCount, usePresets, customPersonalities]);

  const handleStart = useCallback(() => {
    if (isRunning) return;
    if (!model) {
      setStatusMsg("Select a model first");
      return;
    }

    // Use preview players if they exist and match count, otherwise generate new
    let namePersonality: Array<{ name: string; personality: string }>;
    if (previewPlayers.length === playerCount) {
      namePersonality = previewPlayers;
    } else {
      const names = pickRandomNames(playerCount);
      const personalities = usePresets
        ? pickRandomPersonalities(playerCount)
        : customPersonalities.length >= playerCount
          ? shuffle(customPersonalities).slice(0, playerCount)
          : pickRandomPersonalities(playerCount);
      namePersonality = names.map((name, i) => ({ name, personality: personalities[i] }));
    }

    // Build roles
    const roles: MafiaRole[] = [];
    for (let i = 0; i < wolfCount; i++) roles.push("wolf");
    if (playerCount >= 6) {
      roles.push("doctor");
      roles.push("detective");
    }
    while (roles.length < playerCount) roles.push("villager");
    const shuffledRoles = shuffle(roles);

    const gamePlayers: MafiaPlayer[] = namePersonality.map(({ name, personality }, i) => ({
      id: crypto.randomUUID(),
      name,
      personality,
      role: shuffledRoles[i],
      alive: true,
      color: pickColor(i),
    }));

    setPlayers(gamePlayers);
    playersRef.current = gamePlayers;
    setMessages([]);
    messagesRef.current = [];
    setRound(0);
    roundRef.current = 0;
    setPhase("day");
    setWinner(null);
    winnerRef.current = null;
    stopFlagRef.current = false;
    abortRef.current = new AbortController();
    lastProtectedRef.current = null;
    detectiveResultsRef.current = [];
    roundHistoryRef.current = [];
    playerSaidRef.current = new Map();
    setIsRunning(true);
    setStatusMsg("Starting...");
    setPreviewPlayers([]);

    const allNames = gamePlayers.map((p) => p.name).join(", ");
    const specialRoles = playerCount >= 6 ? " A Doctor and Detective walk among them." : "";
    addMessage({
      round: 0,
      phase: "system",
      playerName: "System",
      content: `Game started: ${allNames}. ${wolfCount} wolf${wolfCount > 1 ? "ves" : ""} hide among them.${specialRoles} The village must find them before it's too late.`,
    });

    setTimeout(() => runGame(), 200);
  }, [isRunning, model, playerCount, wolfCount, usePresets, customPersonalities, previewPlayers, addMessage, runGame]);

  const handleStop = useCallback(() => {
    stopFlagRef.current = true;
    abortRef.current?.abort();
    setIsRunning(false);
    setStatusMsg("Stopped");
  }, []);

  // ── derived ──
  const aliveCount = players.filter((p) => p.alive).length;
  const gameOver = phase === "ended" || winner !== null;
  const maxWolves = Math.max(1, Math.floor((playerCount - 1) / 2));

  function roleTagColor(role: MafiaRole): string {
    if (role === "wolf") return "#cc0000";
    if (role === "doctor") return "#0066aa";
    if (role === "detective") return "#886600";
    return "#006600";
  }

  function roleTagLabel(role: MafiaRole): string {
    if (role === "wolf") return "W";
    if (role === "doctor") return "Dr";
    if (role === "detective") return "Det";
    return "V";
  }


  // ── render ──

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#c0c0c0", minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Chat log */}
        <div
          ref={chatContainerRef}
          className="aol-chat w95-deep-inset w95-scrollable"
          style={{ flex: 1, minWidth: 0 }}
          onScroll={() => {
            const el = chatContainerRef.current;
            if (!el) return;
            isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
          }}
        >
          {messages.length === 0 && (
            <>
              <div className="aol-msg aol-msg-system">*** Welcome to Mafia ***</div>
              <div className="aol-msg aol-msg-system">*** Configure settings on the right, then click Start ***</div>
            </>
          )}
          {messages.map((msg) => {
            if (msg.phase === "system") {
              const c = msg.content;
              const cls = c.startsWith("GAME OVER") ? "aol-msg-narrator"
                : c.startsWith("--- DAY") ? "aol-msg-dayheader"
                : c.startsWith("--- NIGHT") ? "aol-msg-nightheader"
                : c.startsWith("--- VOTE") ? "aol-msg-voteheader"
                : c.startsWith("☠") ? "aol-msg-death-kill"
                : c.startsWith("⚖") ? "aol-msg-death-hang"
                : c.startsWith("✚") ? "aol-msg-death-saved"
                : "aol-msg-system";
              return (
                <div key={msg.id} className={`aol-msg ${cls}`}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "vote") {
              const player = players.find((p) => p.id === msg.playerId);
              return (
                <div key={msg.id} className="aol-msg aol-msg-vote">
                  {player && (
                    <span className="aol-name" style={{ color: player.color }}>{msg.playerName}: </span>
                  )}
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "wolf-chat" || msg.phase === "wolf-strategy") {
              const player = players.find((p) => p.id === msg.playerId);
              return (
                <div key={msg.id} className="aol-msg aol-msg-wolf">
                  <span className="aol-name" style={{ color: player?.color }}>{msg.playerName}: </span>
                  {msg.content}
                  {streamingMsgId === msg.id && <span className="aol-cursor" />}
                </div>
              );
            }
            if (msg.phase === "reaction") {
              const player = players.find((p) => p.id === msg.playerId);
              const color = player?.color ?? "#000000";
              return (
                <div key={msg.id} className="aol-msg" style={{ background: "#f0f0f0", borderLeft: "3px solid #666666", fontStyle: "italic" }}>
                  <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                  {msg.content}
                  {streamingMsgId === msg.id && <span className="aol-cursor" />}
                </div>
              );
            }
            if (msg.phase === "doctor") {
              return (
                <div key={msg.id} className="aol-msg" style={{ background: "#e8f4ff", fontStyle: "italic", fontSize: 10, color: "#0066aa" }}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "detective") {
              return (
                <div key={msg.id} className="aol-msg" style={{ background: "#fff8e0", fontStyle: "italic", fontSize: 10, color: "#886600" }}>
                  {msg.content}
                </div>
              );
            }
            // Day speech
            const player = players.find((p) => p.id === msg.playerId);
            const color = player?.color ?? "#000000";
            return (
              <div key={msg.id} className="aol-msg" style={{ background: "#f8f8f8" }}>
                <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                {msg.content}
                {streamingMsgId === msg.id && <span className="aol-cursor" />}
              </div>
            );
          })}

          {/* Role reveal on game over */}
          {gameOver && players.length > 0 && (
            <div style={{
              margin: "8px 6px", padding: "6px 8px",
              background: "#fffff0", border: "2px solid",
              borderColor: "#808080 #ffffff #ffffff #808080",
            }}>
              <div style={{ fontWeight: "bold", fontSize: 11, marginBottom: 4, color: "#000080" }}>
                ROLE REVEAL
              </div>
              {players.map((p) => (
                <div key={p.id} style={{ fontSize: 11, padding: "1px 0" }}>
                  <span style={{ color: p.color, fontWeight: "bold" }}>{p.name}</span>
                  {" — "}
                  <span style={{
                    color: roleTagColor(p.role),
                    fontWeight: "bold",
                  }}>
                    {p.role.toUpperCase()}
                  </span>
                  {!p.alive && <span style={{ color: "#999" }}> (dead)</span>}
                </div>
              ))}
            </div>
          )}

          <div style={{ height: 1 }} />
        </div>

        {/* Right sidebar */}
        <div style={{
          width: 220, flexShrink: 0, display: "flex", flexDirection: "column",
          borderLeft: "2px solid #808080", overflowY: "auto", background: "#c0c0c0",
        }}>

          {/* Players panel */}
          <div style={{ margin: "6px 6px 4px", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080" }}>
            <div style={{
              background: "#000080", color: "#ffffff", fontSize: 10, fontWeight: "bold",
              padding: "2px 5px", display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>Players</span>
              <span style={{ fontSize: 9, fontWeight: "normal" }}>
                {isRunning || players.length > 0 ? `${aliveCount} alive` : `${playerCount} planned`}
              </span>
            </div>
            <div className="w95-scrollable" style={{ background: "#ffffff", borderTop: "1px solid #808080", maxHeight: 200, overflowY: "auto" }}>
              {/* Pre-game preview players */}
              {!isRunning && players.length === 0 && previewPlayers.length > 0 && (
                <>
                  {previewPlayers.map((pp, idx) => (
                    <div key={idx} style={{ padding: "2px 5px", fontSize: 10 }}>
                      {editingIdx === idx ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            style={{ fontSize: 10, fontWeight: "bold", border: "1px solid #808080", padding: "1px 3px" }}
                          />
                          <input
                            type="text"
                            value={editPersonality}
                            onChange={(e) => setEditPersonality(e.target.value)}
                            style={{ fontSize: 9, border: "1px solid #808080", padding: "1px 3px" }}
                          />
                          <div style={{ display: "flex", gap: 2 }}>
                            <button
                              className="w95-btn"
                              style={{ fontSize: 8, padding: "1px 4px" }}
                              onClick={() => {
                                const updated = [...previewPlayers];
                                updated[idx] = { name: editName.trim() || pp.name, personality: editPersonality.trim() || pp.personality };
                                setPreviewPlayers(updated);
                                setEditingIdx(null);
                              }}
                            >OK</button>
                            <button
                              className="w95-btn"
                              style={{ fontSize: 8, padding: "1px 4px" }}
                              onClick={() => setEditingIdx(null)}
                            >Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={() => {
                            setEditingIdx(idx);
                            setEditName(pp.name);
                            setEditPersonality(pp.personality);
                          }}
                          style={{ cursor: "pointer" }}
                          title="Click to edit"
                        >
                          <span style={{ color: pickColor(idx), fontWeight: "bold" }}>{pp.name}</span>
                          <div style={{ fontSize: 8, color: "#888", lineHeight: 1.2 }}>{pp.personality.slice(0, 60)}...</div>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
              {/* Active game players */}
              {players.filter((p) => p.alive).map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", padding: "2px 5px", gap: 5 }}>
                  <span style={{ color: p.color, fontSize: 9, lineHeight: 1 }}>●</span>
                  <span style={{ fontSize: 11, fontWeight: "bold" }}>{p.name}</span>
                  {gameOver && (
                    <span style={{
                      fontSize: 8, fontWeight: "bold", marginLeft: "auto",
                      color: roleTagColor(p.role),
                    }}>
                      {roleTagLabel(p.role)}
                    </span>
                  )}
                </div>
              ))}
              {players.filter((p) => !p.alive).map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", padding: "2px 5px", gap: 5, opacity: 0.5 }}>
                  <span style={{ color: "#aaa", fontSize: 9, lineHeight: 1 }}>●</span>
                  <span style={{ fontSize: 11, color: "#999", textDecoration: "line-through" }}>{p.name}</span>
                  <span style={{
                    fontSize: 8, fontWeight: "bold", marginLeft: "auto",
                    color: roleTagColor(p.role),
                  }}>
                    {roleTagLabel(p.role)}
                  </span>
                </div>
              ))}
              {/* Empty state */}
              {!isRunning && players.length === 0 && previewPlayers.length === 0 && (
                <div style={{ padding: 8, fontSize: 9, color: "#808080", textAlign: "center" }}>
                  Click &quot;Preview&quot; to see players before starting
                </div>
              )}
            </div>
          </div>

          <div className="w95-divider" style={{ margin: "0 6px" }} />

          {/* Controls */}
          <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 3 }}>
              {!isRunning && players.length === 0 && (
                <button className="w95-btn" onClick={generatePreviewPlayers} style={{ flex: 1, fontSize: 10 }}>
                  Preview
                </button>
              )}
              <button className="w95-btn w95-btn-primary" onClick={handleStart} disabled={isRunning} style={{ flex: 1 }}>
                ▶ Start
              </button>
              <button className="w95-btn" onClick={handleStop} disabled={!isRunning} style={{ flex: 1 }}>
                ■ Stop
              </button>
            </div>

            {/* Players slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>PLAYERS</span>
                <span className="w95-trackbar-value">{playerCount}</span>
              </div>
              <W95Slider
                min={4} max={20} step={1}
                value={playerCount}
                onChange={(v) => { setPlayerCount(Math.round(v)); setPreviewPlayers([]); }}
                disabled={isRunning}
              />
            </div>

            {/* Wolves slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>WOLVES</span>
                <span className="w95-trackbar-value">{wolfCount}</span>
              </div>
              <W95Slider
                min={1} max={9} step={1}
                value={wolfCount}
                onChange={(v) => setWolfCount(Math.round(Math.min(v, maxWolves)))}
                disabled={isRunning}
              />
            </div>

            {/* Max rounds slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>MAX ROUNDS</span>
                <span className="w95-trackbar-value">{maxRounds}</span>
              </div>
              <W95Slider
                min={3} max={15} step={1}
                value={maxRounds}
                onChange={(v) => setMaxRounds(Math.round(v))}
                disabled={isRunning}
              />
            </div>

            {/* Model */}
            <div>
              <div style={{ fontSize: 9, color: "#555", fontWeight: "bold", marginBottom: 2 }}>MODEL</div>
              <select
                className="w95-select"
                style={{ width: "100%", fontSize: 10 }}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {availableModels.length === 0 && <option value="">Loading...</option>}
                {availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {/* Temperature */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>TEMP</span>
                <span className="w95-trackbar-value">{temperature.toFixed(2)}</span>
              </div>
              <W95Slider min={0} max={2} step={0.05} value={temperature} onChange={setTemperature} />
            </div>

            {/* Voice rewrite toggle */}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: "bold", color: "#555", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={personalityRewrite}
                onChange={(e) => setPersonalityRewrite(e.target.checked)}
                disabled={isRunning}
              />
              VOICE REWRITE
            </label>

            <div className="w95-divider" />

            {/* View buttons */}
            <div style={{ display: "flex", gap: 3 }}>
              <button
                className="w95-btn"
                style={{ flex: 1, fontSize: 10 }}
                onClick={() => { setShowPastGames(true); loadPastGames(); }}
              >
                Past Games
              </button>
              <button
                className="w95-btn"
                style={{ flex: 1, fontSize: 10 }}
                onClick={() => { setShowStats(true); loadPastGames(); }}
              >
                Stats
              </button>
            </div>
            <button
              className="w95-btn"
              style={{ fontSize: 10 }}
              onClick={() => setShowPrompts(true)}
              disabled={players.length === 0}
            >
              Prompts
            </button>

            <div className="w95-divider" />

            {/* Personality controls */}
            <div style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>PERSONALITIES</div>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}>
              <input
                type="radio"
                name="persona"
                checked={usePresets}
                onChange={() => setUsePresets(true)}
                disabled={isRunning}
              />
              Use built-in presets ({PRESET_PERSONALITIES.length})
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}>
              <input
                type="radio"
                name="persona"
                checked={!usePresets}
                onChange={() => setUsePresets(false)}
                disabled={isRunning}
              />
              Custom / generated
              {customPersonalities.length > 0 && ` (${customPersonalities.length})`}
            </label>
            <button
              className="w95-btn"
              style={{ fontSize: 10 }}
              onClick={generatePersonalities}
              disabled={isRunning || isGenerating || !model}
            >
              {isGenerating ? "Generating..." : "Generate New Set"}
            </button>

            {playerCount >= 6 && (
              <div style={{ fontSize: 8, color: "#555", fontStyle: "italic", marginTop: -2 }}>
                Special roles: Doctor + Detective (6+ players)
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="w95-statusbar">
        <span className="w95-status-pane">Round: {round}</span>
        <span className="w95-status-pane">Phase: {phase}</span>
        <span className="w95-status-pane">Alive: {aliveCount}/{players.length || playerCount}</span>
        <span className="w95-status-pane" style={{ flex: 1 }}>{statusMsg}</span>
      </div>

      {/* Past Games Modal */}
      {showPastGames && !viewingRun && (
        <Dialog title="Past Games" onClose={() => setShowPastGames(false)} width={500}>
          <div className="w95-scrollable" style={{ maxHeight: "60vh", overflowY: "auto", background: "#ffffff" }}>
            {pastGames.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: "#808080", fontSize: 11 }}>
                No saved games yet. Games are saved automatically when they end.
              </div>
            )}
            {pastGames.map((run) => {
              const wolfNames = run.players.filter((p) => p.role === "wolf").map((p) => p.name);
              const winLabel = run.winner === "villagers" ? "Villagers won"
                : run.winner === "wolves" ? "Wolves won" : "Unfinished";
              return (
                <div key={run.id} style={{
                  padding: "6px 10px", borderBottom: "1px solid #c0c0c0",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: "bold" }}>
                      {fmtDate(run.savedAt)}
                      <span style={{
                        marginLeft: 8, fontSize: 10, fontWeight: "normal",
                        color: run.winner === "villagers" ? "#006600" : run.winner === "wolves" ? "#cc0000" : "#808080",
                      }}>
                        {winLabel}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: "#555" }}>
                      {run.players.length} players, {run.roundCount} rounds — Wolves: {wolfNames.join(", ")}
                    </div>
                  </div>
                  <button
                    className="w95-btn"
                    style={{ fontSize: 10 }}
                    onClick={() => setViewingRun(run)}
                  >
                    View
                  </button>
                  <button
                    className="w95-btn"
                    style={{ fontSize: 10, minWidth: 30 }}
                    onClick={() => deleteGame(run.id)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </Dialog>
      )}

      {/* Transcript Viewer */}
      {viewingRun && (
        <TranscriptModal
          run={viewingRun}
          onClose={() => { setViewingRun(null); setShowPastGames(false); }}
          onBack={() => { setViewingRun(null); loadPastGames(); }}
        />
      )}

      {/* Prompt Viewer */}
      {showPrompts && players.length > 0 && (
        <PromptViewerModal
          players={players}
          round={round}
          onClose={() => setShowPrompts(false)}
        />
      )}

      {/* Stats Modal */}
      {showStats && (
        <StatsModal
          games={pastGames}
          onClose={() => setShowStats(false)}
        />
      )}
    </div>
  );
}
