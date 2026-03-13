// schedule.ts — Deterministic routines and decision point detection
// Conway philosophy: simple rules create the base behavior, LLM handles the drama

import type { LifeSimAgent, ToolAction } from "./types";
import { WORK_LOCATIONS } from "./map";

export interface DecisionContext {
  trigger: string;
  urgency: "low" | "medium" | "high";
}

const FOOD_PRIORITY = ["meat", "bread", "fish", "wheat", "ale"];

function bestFood(agent: LifeSimAgent): string | null {
  for (const f of FOOD_PRIORITY) {
    if (agent.inventory.find(i => i.name === f && i.quantity > 0)) return f;
  }
  return null;
}

// ── Deterministic routine: what an agent "would normally do" this tick ──────

export function getRoutineAction(
  agent: LifeSimAgent,
  _allAgents: LifeSimAgent[],
  tick: number,
): ToolAction {
  const phase = tick % 6;

  // ── Always: eat if hungry and have food ──
  if (agent.hunger >= 35) {
    const food = bestFood(agent);
    if (food) return { tool: "eat", args: { item: food } };
  }

  // ── Always: rest if exhausted ──
  if (agent.energy < 10) {
    if (agent.location !== agent.home) return { tool: "move_to", args: { location: agent.home } };
    return { tool: "rest", args: {} };
  }

  // ── Night (phase 5): go home, sleep ──
  if (phase === 5) {
    if (agent.location !== agent.home) return { tool: "move_to", args: { location: agent.home } };
    return { tool: "rest", args: {} };
  }

  // ── Evening (phase 4): tavern if can afford, else home ──
  if (phase === 4) {
    if (agent.energy > 25 && agent.gold >= 2) {
      if (agent.location !== "tavern") return { tool: "move_to", args: { location: "tavern" } };
      return { tool: "observe", args: {} }; // hang out — LLM handles social
    }
    if (agent.location !== agent.home) return { tool: "move_to", args: { location: agent.home } };
    return { tool: "rest", args: {} };
  }

  // ── Afternoon (phase 3): sell goods or buy food ──
  if (phase === 3) {
    const sellable = agent.inventory.find(i =>
      i.quantity > 0 && i.name !== "tools" &&
      !(agent.hunger >= 30 && ["bread", "meat", "fish", "wheat", "ale"].includes(i.name))
    );
    if (sellable) {
      if (agent.location !== "market") return { tool: "move_to", args: { location: "market" } };
      return { tool: "sell", args: { item: sellable.name, quantity: sellable.quantity } };
    }
    if (agent.location === "market" && agent.hunger >= 20 && !bestFood(agent) && agent.gold >= 3) {
      return { tool: "buy", args: { item: "bread", quantity: 1 } };
    }
    // Nothing to sell — might as well work
    const workLocs = WORK_LOCATIONS[agent.occupation] ?? [];
    if (workLocs.includes(agent.location) && agent.energy >= 20) {
      return { tool: "work", args: {} };
    }
  }

  // ── Dawn/Morning/Midday (phases 0-2): work cycle ──
  const workLocs = WORK_LOCATIONS[agent.occupation] ?? [];
  if (workLocs.length > 0 && !workLocs.includes(agent.location)) {
    return { tool: "move_to", args: { location: workLocs[0] } };
  }
  if (workLocs.includes(agent.location) && agent.energy >= 20) {
    return { tool: "work", args: {} };
  }

  // ── Fallback ──
  return { tool: "observe", args: {} };
}

// ── Human-readable description of a routine action ─────────────────────────

export function describeRoutine(action: ToolAction): string {
  const a = action.args as Record<string, string | number | undefined>;
  switch (action.tool) {
    case "eat": return `eat your ${a.item}`;
    case "rest": return "rest and recover";
    case "move_to": return String(a.location) === "home"
      ? "head home"
      : `head to the ${String(a.location).replace(/_/g, " ")}`;
    case "work": return "do your daily work";
    case "sell": return `sell ${a.quantity} ${a.item}`;
    case "buy": return `buy some ${a.item}`;
    case "observe": return "take stock of your surroundings";
    default: return action.tool;
  }
}

// ── Decision point detection: should the LLM be invoked? ───────────────────
// Returns null if routine should handle this turn (no LLM call).
// Returns a DecisionContext if something interesting warrants a real choice.

export function detectDecisionPoint(
  agent: LifeSimAgent,
  allAgents: LifeSimAgent[],
  tick: number,
): DecisionContext | null {
  const othersHere = allAgents.filter(a => a.alive && a.id !== agent.id && a.location === agent.location);
  const recent = agent.memory.slice(-5);
  const recentStr = recent.join(" ");

  // ── High urgency: survival crises ──

  if (agent.hunger >= 50 && !bestFood(agent) && agent.gold < 3) {
    return { trigger: "You're hungry with no food and almost no money. You need to figure something out.", urgency: "high" };
  }

  if (recentStr.includes("attacked you") || recentStr.includes("tried to steal from you")) {
    return { trigger: "You were just attacked or someone tried to rob you.", urgency: "high" };
  }

  if (recentStr.includes("was killed") || recentStr.includes("starved to death")) {
    return { trigger: "Someone just died nearby.", urgency: "high" };
  }

  if (agent.health <= 30) {
    return { trigger: "You're badly hurt and might not survive.", urgency: "high" };
  }

  // ── Medium urgency: social events ──

  if (recent.some(m => m.includes("said") && !m.includes("You said"))) {
    return { trigger: "Someone spoke to you or near you.", urgency: "medium" };
  }

  if (recentStr.includes("proposed to you")) {
    return { trigger: "Someone proposed marriage to you!", urgency: "medium" };
  }

  if (recent.some(m => m.includes("gave you") && !m.includes("You gave"))) {
    return { trigger: "Someone gave you something.", urgency: "medium" };
  }

  if (recentStr.includes("traded you") || recentStr.includes("offered you")) {
    return { trigger: "Someone wants to trade with you.", urgency: "medium" };
  }

  // Strong feelings about someone present
  for (const other of othersHere) {
    const rel = agent.relationships[other.id] ?? 0;
    if (rel >= 50) return { trigger: `${other.name}, someone you care about, is here.`, urgency: "medium" };
    if (rel <= -30) return { trigger: `${other.name}, someone you distrust, is here.`, urgency: "medium" };
  }

  // ── Low urgency: social settings + personality expression ──

  // Tavern is where stories happen
  if (agent.location === "tavern" && othersHere.length > 0 && Math.random() < 0.5) {
    return { trigger: "You're at the tavern with company.", urgency: "low" };
  }

  // Village square gatherings
  if (agent.location === "village_square" && othersHere.length > 0 && Math.random() < 0.35) {
    return { trigger: "People are gathered in the square.", urgency: "low" };
  }

  // Market encounters
  if (agent.location === "market" && othersHere.length > 0 && Math.random() < 0.25) {
    return { trigger: "You see others at the market.", urgency: "low" };
  }

  // Random personality expression when near others (~15% chance)
  if (othersHere.length > 0 && Math.random() < 0.15) {
    return { trigger: "You notice the people around you.", urgency: "low" };
  }

  // Periodic reflection even when alone (~10% on every 6th tick)
  if (tick % 6 === 0 && Math.random() < 0.1) {
    return { trigger: "A quiet moment to yourself.", urgency: "low" };
  }

  return null; // No decision needed — follow routine
}
