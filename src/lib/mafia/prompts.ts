import type { MafiaPlayer, MafiaRole } from "./types";
import { BANNED_PHRASES_LINE } from "./constants";

export type DoctorProtection = { round: number; target: string; saved: boolean };

export type RoundHistoryEntry = {
  round: number;
  hangedName: string | null;
  hangedRole: MafiaRole | null;
  nightKillName: string | null;
  nightKillSaved: boolean;
  votes: Array<{ voter: string; target: string }>;
};

// ── role info ─────────────────────────────────────────────────────────────────

export function buildRoleInfo(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  doctorHistory?: DoctorProtection[],
): string {
  if (player.role === "wolf") {
    const partner = allPlayers.find((p) => p.role === "wolf" && p.id !== player.id && p.alive);
    const partnerInfo = partner ? ` Your fellow wolf is ${partner.name} — protect them without being obvious.` : " You are the last wolf. Be careful.";
    return `Your SECRET role: WOLF. You must blend in with the villagers and avoid suspicion. Manipulate, deflect, and cast doubt on others.${partnerInfo} Never reveal you are a wolf.`;
  } else if (player.role === "doctor") {
    const saves = doctorHistory?.filter((h) => h.saved) ?? [];
    let info: string;
    if (saves.length > 0) {
      info = `Your SECRET role: DOCTOR. You saved ${saves.map((s) => s.target).join(", ")} from death — only you know the wolves targeted them. This is information nobody else has. Revealing yourself is risky (wolves will target you), but if the village is floundering, your save data could change the game.`;
    } else {
      info = "Your SECRET role: DOCTOR. You are a villager with the power to protect one player each night. Keep your role hidden for now — if wolves learn you're the Doctor, they'll target you.";
    }
    if (doctorHistory && doctorHistory.length > 0) {
      const historyLines = doctorHistory.map((h) =>
        `  Night ${h.round}: You protected ${h.target} — ${h.saved ? "SAVED (wolves targeted them!)" : "no attack on them"}.`
      ).join("\n");
      info += `\n\nYour protection history:\n${historyLines}`;
    }
    return info;
  } else if (player.role === "detective") {
    let info = "Your SECRET role: DETECTIVE. You are a villager who can investigate one player each night to learn if they are a wolf.";
    if (detectiveResults && detectiveResults.length > 0) {
      const resultLines = detectiveResults.map((r) =>
        `  Night ${r.round}: You investigated ${r.target} — ${r.isWolf ? "WOLF" : "NOT a wolf"}.`
      ).join("\n");

      const foundWolves = detectiveResults.filter((r) => r.isWolf && allPlayers.find((p) => p.name === r.target)?.alive);
      const cleared = detectiveResults.filter((r) => !r.isWolf).map((r) => r.target);

      info += `\n\nYour investigation results:\n${resultLines}`;
      if (foundWolves.length > 0) {
        const wolfNames = foundWolves.map((r) => r.target).join(" and ");
        info += `\nYou KNOW ${wolfNames} ${foundWolves.length > 1 ? "are wolves" : "is a wolf"}. The village is dying without this information. Consider revealing yourself as detective and sharing your results — yes it paints a target on you, but staying silent lets the wolf walk free. Push hard to get them voted out.`;
      } else if (cleared.length >= 2) {
        info += `\nYou've cleared ${cleared.join(" and ")}. The village needs direction. Consider vouching for cleared players or even revealing your role to give the town something solid to work with.`;
      } else {
        info += `\nUse this information strategically. You can hint at special knowledge without revealing your role yet.`;
      }
    } else {
      info += " Keep your role hidden for now — revealing too early makes you a target with nothing to show for it.";
    }
    return info;
  } else {
    return "Your SECRET role: VILLAGER. You must figure out who the wolves are and convince others to vote them out. Watch for suspicious behavior — deflection, vagueness, convenient accusations.";
  }
}

// ── round history & escalation helpers ────────────────────────────────────────

export function buildRoundRecap(history: RoundHistoryEntry[]): string {
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

  // Cross-round analysis: flag who voted to spare confirmed wolves
  for (const h of history) {
    if (h.hangedRole === "wolf" && h.hangedName && h.votes.length > 0) {
      const didNotVoteForWolf = h.votes
        .filter((v) => v.target !== h.hangedName)
        .map((v) => v.voter);
      if (didNotVoteForWolf.length > 0) {
        lines.push(`  ⚠ Day ${h.round}: ${didNotVoteForWolf.join(", ")} did NOT vote for ${h.hangedName} (revealed WOLF) — worth scrutinizing`);
      }
    }
  }

  // Cross-round analysis: voting pairs (voted same target 2+ times)
  if (history.length >= 2) {
    const pairCounts = new Map<string, number>();
    for (const h of history) {
      const targetVoters = new Map<string, string[]>();
      for (const v of h.votes) {
        const arr = targetVoters.get(v.target) || [];
        arr.push(v.voter);
        targetVoters.set(v.target, arr);
      }
      for (const voters of targetVoters.values()) {
        if (voters.length < 2) continue;
        for (let i = 0; i < voters.length; i++) {
          for (let j = i + 1; j < voters.length; j++) {
            const key = [voters[i], voters[j]].sort().join(" & ");
            pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
          }
        }
      }
    }
    const frequentPairs = [...pairCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (frequentPairs.length > 0) {
      lines.push("  Vote patterns:");
      for (const [pair, count] of frequentPairs) {
        lines.push(`    ${pair} voted the same way ${count} times — allied or coordinating?`);
      }
    }
  }

  return lines.join("\n");
}

export function buildEscalationNote(aliveCount: number, round: number): string {
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

// ── prompt builders ──────────────────────────────────────────────────────────

export function buildDayPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  roundHistory?: RoundHistoryEntry[],
  previousSaid?: string[],
  wolfStrategyContent?: string[],
  doctorHistory?: DoctorProtection[],
  notYetSpoken?: string[],
  echoWarning?: string | null,
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const dead = allPlayers.filter((p) => !p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");
  const deadInfo = dead.length > 0
    ? `\nEliminated (DEAD — do NOT accuse, discuss, or vote for them): ${dead.map((p) => p.name).join(", ")}`
    : "";

  const roleInfo = buildRoleInfo(player, allPlayers, detectiveResults, doctorHistory);

  const recap = roundHistory ? buildRoundRecap(roundHistory) : "";
  const escalation = buildEscalationNote(alive.length, round);
  const noRepeat = previousSaid && previousSaid.length > 0
    ? ` You have already said things like: "${previousSaid.slice(-3).join('"; "')}". Say something NEW — a different observation, a new suspicion, a fresh angle. Do not repeat yourself.`
    : "";
  const echoLine = echoWarning
    ? ` The group keeps circling around the same point. Break the loop — bring up something no one has mentioned, or take a completely different angle.`
    : "";

  const textOnly = " This is a text-only discussion — you CANNOT see body language, facial expressions, physical reactions, or locations. Do not reference any physical observations.";
  const knowledgeAnchor = round === 1
    ? `\nThis is the FIRST round. You have never spoken to these people before. You have NO prior observations, no night chat history, no timestamps, no private messages — nothing has happened yet. You can only react to what people say RIGHT NOW in this discussion. Do not reference or invent events from before this moment.${textOnly}`
    : `\nEVERYTHING you know comes from the discussion transcript and round recap above. If it's not there, it didn't happen. No locations, no physical clues, no private conversations exist.${textOnly}`;

  const notYetSpokenLine = notYetSpoken && notYetSpoken.length > 0
    ? `\nThese players haven't spoken yet this round: ${notYetSpoken.join(", ")}. Do not comment on their silence — they simply haven't had their turn yet.`
    : "";

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
    `It is Day ${round}.${knowledgeAnchor}${notYetSpokenLine} Speak to the group — focus ONLY on living players. Dead players are gone and irrelevant. Stay in character. Be strategic but natural — 2-4 sentences. Vary your approach: address the whole group, ask a pointed question, make a bold accusation, express genuine doubt, or share a gut feeling. Don't narrate actions or use asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.${escalation}${noRepeat}${echoLine}`,
  ].join("\n");
}

export function buildRebuttalPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  accuserNames: string[],
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  doctorHistory?: DoctorProtection[],
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = buildRoleInfo(player, allPlayers, detectiveResults, doctorHistory);
  const revealHint = player.role === "wolf"
    ? "\nDesperate times call for desperate measures. You could fake-claim detective or doctor — invent investigation results or protection saves to defend yourself. Bold lies sometimes work. This is high-risk but doing nothing gets you hanged."
    : (player.role === "doctor" || player.role === "detective")
      ? "\nYou are under suspicion. Revealing your role and sharing your evidence could save your life. Yes, wolves will target you — but you're about to die anyway. It's your call."
      : "";

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
    roleInfo + revealHint,
    "",
    `Your name has come up multiple times in today's discussion. ${accuserList} seem${accuserNames.length === 1 ? 's' : ''} suspicious of you.`,
    `Address their concerns directly. Defend yourself, challenge your accusers, or redirect suspicion. Be passionate and specific — 2-3 sentences. Don't narrate actions or use asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. Only reference events from the transcript. If you didn't read it above, it didn't happen. This is text-only — no body language, facial expressions, or physical observations.${buildEscalationNote(alive.length, round)}`,
  ].join("\n");
}

export function buildFollowUpPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  defendingPlayerName: string,
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  doctorHistory?: DoctorProtection[],
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  let roleInfo = buildRoleInfo(player, allPlayers, detectiveResults, doctorHistory);
  if (player.role === "wolf") {
    roleInfo += "\nPress your case strategically or back off if pressing draws too much attention to you.";
  }

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

export function buildVotePrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  roundHistory?: RoundHistoryEntry[],
  round?: number,
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  doctorHistory?: DoctorProtection[],
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== player.id);
  const dead = allPlayers.filter((p) => !p.alive);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = buildRoleInfo(player, allPlayers, detectiveResults, doctorHistory);
  let roleHint: string;
  if (player.role === "wolf") {
    roleHint = "Vote strategically — condemn a villager or sacrifice a weak wolf to maintain cover.";
  } else if (player.role === "detective") {
    const confirmedWolf = detectiveResults?.find((r) => r.isWolf && allPlayers.find((p) => p.name === r.target)?.alive);
    roleHint = confirmedWolf
      ? `You KNOW ${confirmedWolf.target} is a wolf. Vote for them with conviction — use your knowledge.`
      : "Vote based on your observations and investigation results.";
  } else if (player.role === "doctor") {
    roleHint = "Vote based on your observations. Your protection history may give you insights into wolf behavior.";
  } else {
    roleHint = "Vote for whoever you believe is a wolf.";
  }

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
    roleInfo,
    "",
    `You can ONLY vote for one of these living players: ${aliveNames}.${deadWarning}`,
    roleHint,
    ...(recap ? ["", recap] : []),
    "",
    `The town is voting to put someone on trial. Base your vote on YOUR OWN reading of the discussion — who struck you as evasive, inconsistent, or suspicious? Name the person YOU find most suspicious and say why, referencing specific things they said or did. 1-2 sentences. No hedging — name one living person clearly. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags. Only reference events from the transcript. If you didn't read it above, it didn't happen.${escalation}`,
  ].join("\n");
}

export function buildTrialDefensePrompt(
  accused: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  doctorHistory?: DoctorProtection[],
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== accused.id);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = buildRoleInfo(accused, allPlayers, detectiveResults, doctorHistory);
  const revealHint = accused.role === "wolf"
    ? "\nYour life is on the line. You could fake-claim detective or doctor — invent investigation results or protection saves. A bold lie might save you. Doing nothing gets you killed."
    : (accused.role === "doctor" || accused.role === "detective")
      ? "\nYour life is on the line. Reveal your role and share your evidence to prove your innocence — wolves will target you, but you're about to die anyway. Show them what you know."
      : "";

  return [
    `You are ${accused.name}. Your personality influences your style, not your competence.`,
    `${accused.personality}`,
    "",
    roleInfo + revealHint,
    "",
    `The village has accused you. You are on trial for your life. The remaining players (${aliveNames}) will vote to hang or spare you after you speak.`,
    "",
    `Make your case — defend yourself, deflect suspicion, accuse someone else, plead for mercy, or reveal what you know. This is your one chance to convince them. 2-3 sentences. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

export function buildJudgmentVotePrompt(
  voter: MafiaPlayer,
  accused: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
): string {
  let roleHint: string;
  if (voter.role === "wolf") {
    roleHint = accused.role === "wolf"
      ? "As a fellow wolf, you probably want to spare them — but voting to spare too eagerly may reveal you."
      : "As a wolf, hanging a villager benefits you.";
  } else if (voter.role === "detective") {
    const accusedResult = detectiveResults?.find((r) => r.target === accused.name);
    if (accusedResult?.isWolf) {
      roleHint = `You KNOW ${accused.name} is a wolf from your investigation. Vote to hang them.`;
    } else if (accusedResult && !accusedResult.isWolf) {
      roleHint = `You KNOW ${accused.name} is NOT a wolf from your investigation. Spare them — hanging an innocent helps the wolves.`;
    } else {
      roleHint = "As a villager, hang them if you think they're a wolf. Spare them if you're not convinced.";
    }
  } else {
    roleHint = "As a villager, hang them if you think they're a wolf. Spare them if you're not convinced.";
  }

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

export function buildWolfDiscussionPrompt(
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

export function buildDoctorPrompt(
  doctor: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  lastProtected: string | null,
  roundHistory?: RoundHistoryEntry[],
): string {
  const alive = allPlayers.filter((p) => p.alive);
  const candidates = alive.filter((p) => p.name !== lastProtected);
  const candidateNames = candidates.map((p) => p.name).join(", ");

  const restriction = lastProtected
    ? `\nYou CANNOT protect ${lastProtected} — you protected them last night.`
    : "";

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

export function buildDetectivePrompt(
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

export function buildLastWordsPrompt(
  player: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  detectiveResults?: Array<{ round: number; target: string; isWolf: boolean }>,
  doctorHistory?: DoctorProtection[],
): string {
  const alive = allPlayers.filter((p) => p.alive && p.id !== player.id);
  const aliveNames = alive.map((p) => p.name).join(", ");

  const roleInfo = buildRoleInfo(player, allPlayers, detectiveResults, doctorHistory);
  const deathReveal = (player.role === "detective" || player.role === "doctor")
    ? "\nYou're about to die — there's no reason to hide your role anymore. Share everything you know to help the village."
    : player.role === "wolf"
      ? "\nYou can use your last words to mislead, cast doubt on an innocent, or protect your fellow wolf — or go out with defiance."
      : "";

  return [
    `You are ${player.name}. ${player.personality}`,
    "",
    roleInfo + deathReveal,
    "",
    `The village has condemned you. Speak from the heart — not from your archetype. The noose is around your neck — these are your final moments.`,
    `Remaining players: ${aliveNames}`,
    "",
    `Say your last words — share your suspicions, reveal what you know, make a final accusation, or leave a parting message. 1-2 sentences. No actions, no asterisks. Respond with dialogue only — no internal reasoning, no thinking tags.`,
  ].join("\n");
}

export function buildDeathReactionPrompt(
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

export function buildWolfStrategyPrompt(
  wolf: MafiaPlayer,
  allPlayers: MafiaPlayer[],
  round: number,
  roundHistory: RoundHistoryEntry[],
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

export function buildInterjectionPrompt(
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

export function buildGeneratorPrompt(count: number, existing: string[]): string {
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
