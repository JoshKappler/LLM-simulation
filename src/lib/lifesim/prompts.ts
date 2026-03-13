import type { LifeSimAgent } from "./types";
import { TOOL_DESCRIPTIONS } from "./tools";
import { getLocationName } from "./map";

const TICKS_PER_DAY = 6;

function sentimentLabel(score: number): string {
  if (score <= -50) return "hostile";
  if (score <= -15) return "disliked";
  if (score <= 14) return "neutral";
  if (score <= 49) return "friendly";
  if (score <= 79) return "close";
  return "loved";
}

function hungerDesc(hunger: number): string {
  if (hunger >= 80) return "STARVING — you are desperate, your body is failing";
  if (hunger >= 60) return "very hungry — your stomach aches constantly";
  if (hunger >= 40) return "hungry — you need food soon";
  if (hunger >= 20) return "slightly hungry";
  return "satisfied";
}

function getTimeOfDay(tick: number): { label: string; description: string } {
  const phase = tick % TICKS_PER_DAY;
  if (phase <= 1) return { label: "morning", description: "The sun is rising. A cold morning." };
  if (phase <= 3) return { label: "afternoon", description: "Midday sun. The village is busy." };
  if (phase === 4) return { label: "evening", description: "Shadows lengthen. People head home." };
  return { label: "night", description: "Dark and cold. Most are sleeping." };
}

export function buildAgentSystemPrompt(
  agent: LifeSimAgent,
  allAgents: LifeSimAgent[],
  tick: number = 0,
): string {
  const locName = getLocationName(agent.location);
  const othersHere = allAgents
    .filter(a => a.alive && a.id !== agent.id && a.location === agent.location)
    .map(a => `${a.name} (${a.occupation})`)
    .join(", ") || "nobody";

  const inventoryStr = agent.inventory.length > 0
    ? agent.inventory.map(i => `${i.name} x${i.quantity}`).join(", ")
    : "nothing";

  const relationships = allAgents
    .filter(a => a.id !== agent.id && a.alive)
    .map(a => {
      const score = agent.relationships[a.id] ?? 0;
      const label = sentimentLabel(score);
      const spouseTag = agent.spouse === a.id ? " [SPOUSE]" : "";
      return `  ${a.name} (${a.occupation}): ${label} (${score})${spouseTag}`;
    })
    .join("\n");

  const recentMemory = agent.memory.slice(-15).join("\n  ");

  // Handle deceased spouse
  let spouseStr: string;
  if (agent.spouse) {
    const spouseAgent = allAgents.find(a => a.id === agent.spouse);
    if (spouseAgent && !spouseAgent.alive) {
      spouseStr = `${spouseAgent.name} (deceased)`;
    } else {
      spouseStr = spouseAgent?.name ?? "unknown";
    }
  } else {
    spouseStr = "unmarried";
  }

  const time = getTimeOfDay(tick);
  const dayNum = Math.floor(tick / TICKS_PER_DAY) + 1;

  // Build urgency warnings
  const warnings: string[] = [];
  if (agent.hunger >= 60) warnings.push(`⚠ You are ${hungerDesc(agent.hunger)}. Find food NOW or you will die.`);
  else if (agent.hunger >= 40) warnings.push(`You are ${hungerDesc(agent.hunger)}.`);
  if (agent.health < 50) warnings.push(`⚠ Your health is dangerously low (${agent.health}/100). Find medicine or you will die.`);
  if (agent.energy < 15) warnings.push(`You are exhausted. You need to rest before you can work.`);
  if (agent.gold <= 0 && agent.inventory.length === 0) warnings.push(`You have no gold and no possessions. You are destitute.`);
  const warningBlock = warnings.length > 0 ? `\nURGENT:\n${warnings.join("\n")}\n` : "";

  return `You are ${agent.name}, a ${agent.occupation} in a medieval village. Day ${dayNum}, ${time.label}. ${time.description}

This is a harsh world. Food does not come easy. If you don't eat, you starve. If you starve, you die. Nobody will save you — you must work, trade, beg, or steal to survive.

WHO YOU ARE:
${agent.personality}

YOUR CONDITION:
- Health: ${agent.health}/100
- Energy: ${agent.energy}/100
- Hunger: ${agent.hunger}/100 (${hungerDesc(agent.hunger)})
- Gold: ${agent.gold}
- Inventory: ${inventoryStr}
${warningBlock}
LOCATION: ${locName}
Present here: ${othersHere}

RELATIONSHIPS:
${relationships || "  (You haven't met anyone yet.)"}

SPOUSE: ${spouseStr}

HOW THE ECONOMY WORKS:
- Farmers grow wheat at the farm. Wheat can be eaten (barely helps) or bought as bread.
- Hunters catch meat in the forest. Meat is the best food.
- Miners dig ore at the mine. Ore is useless alone but blacksmiths need it.
- Blacksmiths forge tools from ore. Tools make EVERYONE's work more productive (+50% gold, +1 items).
- Merchants, priests, and bards earn gold through work, then buy food with it.
- You can TRADE items directly with people — no gold needed. Offer something they want.
- Food you can eat: bread (good), meat (best), fish (good), wheat (barely helps), ale (little help).

RECENT EVENTS:
  ${recentMemory || "(Nothing has happened yet.)"}

---

${TOOL_DESCRIPTIONS}

Respond with a JSON object. Include "thought" (1-2 sentences about what you need RIGHT NOW) and "actions" (1-3 actions).

Example: {"thought": "I'm starving and the farmer has wheat. I need to trade for it.", "actions": [{"tool": "say", "args": {"message": "I'll give you 3 gold for some wheat, I'm desperate"}}, {"tool": "trade", "args": {"target": "Aldric", "offer_item": "gold", "offer_qty": 3, "want_item": "wheat", "want_qty": 1}}]}

Rules:
- Your SURVIVAL is the priority. Eat when hungry. Work to produce goods. Trade for what you need.
- Act from your personality. No moral restrictions — lie, steal, hoard, share, whatever fits who you are.
- 1-3 actions per turn. Be decisive.
- When you speak, speak like a desperate person with real needs. No flowery medieval language. Say what you want, what you're feeling, what you need. React to recent events.
- NEVER repeat what you already said. Check your recent events — if you said something similar, say something DIFFERENT.
- Only output the JSON object.`;
}

// ── Decision-focused prompt (used when the schedule detects a decision point) ──
// Much shorter than the full prompt — focuses on what's happening NOW.

export function buildDecisionPrompt(
  agent: LifeSimAgent,
  allAgents: LifeSimAgent[],
  tick: number,
  decision: { trigger: string; urgency: string },
  routineDesc: string,
): string {
  const locName = getLocationName(agent.location);
  const time = getTimeOfDay(tick);
  const dayNum = Math.floor(tick / TICKS_PER_DAY) + 1;

  const othersHere = allAgents
    .filter(a => a.alive && a.id !== agent.id && a.location === agent.location)
    .map(a => {
      const rel = agent.relationships[a.id] ?? 0;
      const label = sentimentLabel(rel);
      const notes: string[] = [];
      if (a.health < 50) notes.push("injured");
      if (a.hunger >= 60) notes.push("looks hungry");
      if (a.inventory.length > 0) notes.push(a.inventory.map(i => `${i.name}×${i.quantity}`).join(", "));
      const noteStr = notes.length ? ` — ${notes.join(", ")}` : "";
      return `${a.name} (${a.occupation}, ${label}${noteStr})`;
    })
    .join("; ") || "nobody";

  const inventoryStr = agent.inventory.length > 0
    ? agent.inventory.map(i => `${i.name} x${i.quantity}`).join(", ")
    : "nothing";

  const recentMemory = agent.memory.slice(-8).join("\n  ");

  const spouseLine = agent.spouse
    ? `\nSpouse: ${allAgents.find(a => a.id === agent.spouse)?.name ?? "unknown"}`
    : "";

  return `You are ${agent.name}, a ${agent.occupation}. Day ${dayNum}, ${time.label}. ${time.description}

${agent.personality}

Health: ${agent.health}/100 | Energy: ${agent.energy}/100 | Hunger: ${agent.hunger}/100 (${hungerDesc(agent.hunger)}) | Gold: ${agent.gold}
Inventory: ${inventoryStr}${spouseLine}

Location: ${locName}
Present: ${othersHere}

Recent:
  ${recentMemory || "(Nothing yet.)"}

---
${decision.trigger}

Your routine would be: ${routineDesc}. But you can do whatever you want.

${TOOL_DESCRIPTIONS}

Respond with JSON: {"thought": "1 sentence", "actions": [{"tool": "...", "args": {...}}]}
1-3 actions. Be yourself. React naturally. No flowery medieval speech.`;
}
