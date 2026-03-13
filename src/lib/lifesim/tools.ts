import type { LifeSimAgent, SimEvent, ToolAction } from "./types";
import { LOCATIONS, WORK_LOCATIONS, ITEM_PRICES, getLocationName } from "./map";

// ── Food items (can be eaten to reduce hunger) ──────────────────────────────
const FOOD_ITEMS: Record<string, number> = {
  bread: 35,   // filling
  meat: 45,    // very filling
  fish: 40,    // filling
  wheat: 15,   // raw, barely useful
  ale: 10,     // takes the edge off
};

// ── Work outputs by occupation ──────────────────────────────────────────────
// Each occupation produces specific goods when working
const WORK_OUTPUTS: Record<string, { item: string; minQty: number; maxQty: number; bonusItem?: string }> = {
  farmer: { item: "wheat", minQty: 2, maxQty: 4 },
  hunter: { item: "meat", minQty: 1, maxQty: 3 },
  miner: { item: "ore", minQty: 1, maxQty: 3 },
  blacksmith: { item: "tools", minQty: 1, maxQty: 1, bonusItem: "ore" }, // consumes ore
  merchant: { item: "gold", minQty: 8, maxQty: 15 },
  priest: { item: "gold", minQty: 5, maxQty: 10 },
  bard: { item: "gold", minQty: 5, maxQty: 12 },
};

// ── Tool descriptions (included in system prompt) ───────────────────────────

export const TOOL_DESCRIPTIONS = `Available actions:
- move_to(location): Move to a location. Locations: ${LOCATIONS.map(l => l.id).join(", ")}
- observe(): Look around. See who is here, their condition, and what they carry.
- say(message, target?): Say something aloud. Everyone at your location hears.
- give(target, item, quantity): Give an item or gold to someone here. item="gold" for gold.
- trade(target, offer_item, offer_qty, want_item, want_qty): Propose a barter trade. The other person can accept or reject based on how they feel about you and the deal.
- steal(target, item?): Attempt to steal. Risky — witnesses make it harder, getting caught destroys reputation.
- attack(target): Attack someone here. Deals damage. Sword helps. Once per turn only.
- work(): Do your occupation's work at the right location. Farmers produce wheat (farm), hunters produce meat (forest), miners produce ore (mine), blacksmiths forge tools from ore (blacksmith), merchants/priests/bards earn gold.
- buy(item, quantity): Buy at Market or Blacksmith. Items: ${Object.keys(ITEM_PRICES).join(", ")}
- sell(item, quantity): Sell inventory at the Market for 60% of buy price.
- eat(item): Eat food to reduce hunger. Food: bread (good), meat (best), fish (good), wheat (barely helps), ale (little).
- rest(): Recover energy. Best at home (+40) or tavern (+35, costs 2g). Elsewhere: +20.
- propose(target): Propose marriage to someone here.`;

// ── Tool resolution ───────────────────────────────────────────────────────────

let eventCounter = 0;
function makeEventId(): string {
  return `ev_${Date.now()}_${eventCounter++}`;
}

function findAgentByName(agents: LifeSimAgent[], name: string): LifeSimAgent | undefined {
  return agents.find(a => a.alive && a.name.toLowerCase() === name.toLowerCase());
}

function agentsAtLocation(agents: LifeSimAgent[], locationId: string, excludeId?: string): LifeSimAgent[] {
  return agents.filter(a => a.alive && a.location === locationId && a.id !== excludeId);
}

function addItem(agent: LifeSimAgent, name: string, qty: number) {
  const existing = agent.inventory.find(i => i.name === name);
  if (existing) existing.quantity += qty;
  else agent.inventory.push({ name, quantity: qty });
}

function removeItem(agent: LifeSimAgent, name: string, qty: number): boolean {
  const existing = agent.inventory.find(i => i.name === name);
  if (!existing || existing.quantity < qty) return false;
  existing.quantity -= qty;
  if (existing.quantity <= 0) {
    agent.inventory = agent.inventory.filter(i => i.name !== name);
  }
  return true;
}

function hasItem(agent: LifeSimAgent, name: string, qty = 1): boolean {
  const existing = agent.inventory.find(i => i.name === name);
  return !!existing && existing.quantity >= qty;
}

function mem(tick: number, text: string): string {
  return `[Turn ${tick}] ${text}`;
}

function clampRelationship(val: number): number {
  return Math.max(-100, Math.min(100, val));
}

function adjustRelationship(agent: LifeSimAgent, targetId: string, delta: number) {
  const current = agent.relationships[targetId] ?? 0;
  agent.relationships[targetId] = clampRelationship(current + delta);
}

function hungerDesc(hunger: number): string {
  if (hunger >= 80) return "starving";
  if (hunger >= 60) return "very hungry";
  if (hunger >= 40) return "hungry";
  if (hunger >= 20) return "peckish";
  return "satisfied";
}

export interface ToolResult {
  event: SimEvent;
  memoryForAgent: string;
  memoryForWitnesses?: string;
  memoryForAll?: string;
  targetMemory?: { targetId: string; text: string };
  departureMemory?: { locationId: string; text: string };
}

// Track attacks within a single turn to enforce 1-attack limit
const attacksThisTurn = new Set<string>();

export function resetTurnTracking() {
  attacksThisTurn.clear();
}

export function resolveTool(
  action: ToolAction,
  agent: LifeSimAgent,
  allAgents: LifeSimAgent[],
  tick: number,
): ToolResult | null {
  const { tool, args } = action;
  const a = args as Record<string, string | number | undefined>;

  switch (tool) {
    case "move_to": return resolveMove(agent, String(a.location ?? ""), allAgents, tick);
    case "observe": return resolveObserve(agent, allAgents, tick);
    case "say": return resolveSay(agent, String(a.message ?? ""), a.target ? String(a.target) : undefined, tick);
    case "give": return resolveGive(agent, allAgents, String(a.target ?? ""), String(a.item ?? "gold"), Number(a.quantity ?? 1), tick);
    case "trade": return resolveTrade(agent, allAgents, String(a.target ?? ""), String(a.offer_item ?? ""), Number(a.offer_qty ?? 1), String(a.want_item ?? ""), Number(a.want_qty ?? 1), tick);
    case "steal": return resolveSteal(agent, allAgents, String(a.target ?? ""), a.item ? String(a.item) : "gold", tick);
    case "attack": return resolveAttack(agent, allAgents, String(a.target ?? ""), tick);
    case "work": return resolveWork(agent, tick);
    case "buy": return resolveBuy(agent, String(a.item ?? ""), Number(a.quantity ?? 1), tick);
    case "sell": return resolveSell(agent, String(a.item ?? ""), Number(a.quantity ?? 1), tick);
    case "eat": return resolveEat(agent, String(a.item ?? ""), tick);
    case "rest": return resolveRest(agent, tick);
    case "use": return resolveEat(agent, String(a.item ?? ""), tick); // backward compat
    case "propose": return resolvePropose(agent, allAgents, String(a.target ?? ""), tick);
    default: return null;
  }
}

function baseEvent(agent: LifeSimAgent, tick: number): Partial<SimEvent> {
  return {
    id: makeEventId(),
    tick,
    agentId: agent.id,
    agentName: agent.name,
    location: agent.location,
    timestamp: Date.now(),
  };
}

// ── Individual tool resolvers ─────────────────────────────────────────────────

function resolveMove(agent: LifeSimAgent, locationId: string, allAgents: LifeSimAgent[], tick: number): ToolResult | null {
  const targetLocId = locationId === "home" ? agent.home : locationId;
  const loc = LOCATIONS.find(l => l.id === targetLocId);
  if (!loc) {
    return {
      event: { ...baseEvent(agent, tick), type: "move", result: `No such location: ${locationId}` } as SimEvent,
      memoryForAgent: mem(tick, `You tried to move to "${locationId}" but it doesn't exist.`),
    };
  }
  if (agent.location === targetLocId) {
    return {
      event: { ...baseEvent(agent, tick), type: "move", result: `Already at ${loc.name}` } as SimEvent,
      memoryForAgent: mem(tick, `You are already at the ${loc.name}.`),
    };
  }

  const oldLocId = agent.location;
  const oldLoc = getLocationName(oldLocId);
  agent.location = targetLocId;

  return {
    event: { ...baseEvent(agent, tick), type: "move", result: `Moved to ${loc.name}` } as SimEvent,
    memoryForAgent: mem(tick, `You moved from the ${oldLoc} to the ${loc.name}.`),
    memoryForWitnesses: mem(tick, `${agent.name} arrived at the ${loc.name}.`),
    departureMemory: { locationId: oldLocId, text: mem(tick, `${agent.name} left the ${oldLoc}.`) },
  };
}

function resolveObserve(agent: LifeSimAgent, allAgents: LifeSimAgent[], tick: number): ToolResult {
  const locName = getLocationName(agent.location);
  const others = agentsAtLocation(allAgents, agent.location, agent.id);

  let othersList: string;
  if (others.length > 0) {
    othersList = others.map(o => {
      const healthStr = o.health < 100 ? `, ${o.health} HP` : "";
      const hungerStr = o.hunger >= 40 ? `, looks ${hungerDesc(o.hunger)}` : "";
      const items = o.inventory.length > 0
        ? `, carrying: ${o.inventory.map(i => `${i.name} x${i.quantity}`).join(", ")}`
        : "";
      return `${o.name} (${o.occupation}${healthStr}${hungerStr}${items})`;
    }).join("; ");
  } else {
    othersList = "nobody";
  }

  const result = `You are at the ${locName}. Present: ${othersList}.`;

  return {
    event: { ...baseEvent(agent, tick), type: "observe", result } as SimEvent,
    memoryForAgent: mem(tick, result),
  };
}

function resolveSay(agent: LifeSimAgent, message: string, target: string | undefined, tick: number): ToolResult {
  const targetStr = target && target !== "everyone" ? ` to ${target}` : "";

  return {
    event: { ...baseEvent(agent, tick), type: "say", message, target, result: `Said${targetStr}: "${message}"` } as SimEvent,
    memoryForAgent: mem(tick, `You said${targetStr}: "${message}"`),
    memoryForWitnesses: mem(tick, `${agent.name} said${targetStr}: "${message}"`),
  };
}

function resolveGive(agent: LifeSimAgent, allAgents: LifeSimAgent[], targetName: string, item: string, quantity: number, tick: number): ToolResult {
  const target = findAgentByName(allAgents, targetName);
  if (!target || target.location !== agent.location) {
    return {
      event: { ...baseEvent(agent, tick), type: "give", target: targetName, result: `${targetName} is not here.` } as SimEvent,
      memoryForAgent: mem(tick, `You tried to give to ${targetName} but they aren't here.`),
    };
  }

  if (item.toLowerCase() === "gold") {
    if (agent.gold < quantity) {
      return {
        event: { ...baseEvent(agent, tick), type: "give", target: targetName, result: "Not enough gold." } as SimEvent,
        memoryForAgent: mem(tick, `You tried to give ${quantity} gold to ${targetName} but you only have ${agent.gold}.`),
      };
    }
    agent.gold -= quantity;
    target.gold += quantity;
    adjustRelationship(target, agent.id, Math.min(15, Math.ceil(quantity / 2)));
    adjustRelationship(agent, target.id, 5);

    return {
      event: { ...baseEvent(agent, tick), type: "give", target: targetName, item: "gold", quantity, gold: quantity, result: `Gave ${quantity} gold to ${targetName}.` } as SimEvent,
      memoryForAgent: mem(tick, `You gave ${quantity} gold to ${targetName}.`),
      memoryForWitnesses: mem(tick, `${agent.name} gave ${quantity} gold to ${targetName}.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} gave you ${quantity} gold.`) },
    };
  } else {
    if (!removeItem(agent, item, quantity)) {
      return {
        event: { ...baseEvent(agent, tick), type: "give", target: targetName, item, result: `You don't have ${quantity} ${item}.` } as SimEvent,
        memoryForAgent: mem(tick, `You tried to give ${quantity} ${item} to ${targetName} but you don't have enough.`),
      };
    }
    addItem(target, item, quantity);
    adjustRelationship(target, agent.id, 15);
    adjustRelationship(agent, target.id, 5);

    return {
      event: { ...baseEvent(agent, tick), type: "give", target: targetName, item, quantity, result: `Gave ${quantity} ${item} to ${targetName}.` } as SimEvent,
      memoryForAgent: mem(tick, `You gave ${quantity} ${item} to ${targetName}.`),
      memoryForWitnesses: mem(tick, `${agent.name} gave ${quantity} ${item} to ${targetName}.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} gave you ${quantity} ${item}.`) },
    };
  }
}

// ── Barter trade ────────────────────────────────────────────────────────────

function resolveTrade(
  agent: LifeSimAgent, allAgents: LifeSimAgent[],
  targetName: string, offerItem: string, offerQty: number,
  wantItem: string, wantQty: number, tick: number,
): ToolResult {
  const target = findAgentByName(allAgents, targetName);
  if (!target || target.location !== agent.location) {
    return {
      event: { ...baseEvent(agent, tick), type: "trade_reject", target: targetName, result: `${targetName} is not here.` } as SimEvent,
      memoryForAgent: mem(tick, `You tried to trade with ${targetName} but they aren't here.`),
    };
  }

  // Check agent has the offered goods
  const offerIsGold = offerItem.toLowerCase() === "gold";
  const wantIsGold = wantItem.toLowerCase() === "gold";

  if (offerIsGold && agent.gold < offerQty) {
    return {
      event: { ...baseEvent(agent, tick), type: "trade_reject", target: targetName, result: "Not enough gold to offer." } as SimEvent,
      memoryForAgent: mem(tick, `You can't afford to offer ${offerQty} gold.`),
    };
  }
  if (!offerIsGold && !hasItem(agent, offerItem.toLowerCase(), offerQty)) {
    return {
      event: { ...baseEvent(agent, tick), type: "trade_reject", target: targetName, result: `You don't have ${offerQty} ${offerItem}.` } as SimEvent,
      memoryForAgent: mem(tick, `You don't have ${offerQty} ${offerItem} to offer.`),
    };
  }

  // Check target has what agent wants
  if (wantIsGold && target.gold < wantQty) {
    return {
      event: { ...baseEvent(agent, tick), type: "trade_reject", target: targetName, result: `${targetName} doesn't have ${wantQty} gold.` } as SimEvent,
      memoryForAgent: mem(tick, `${targetName} doesn't have ${wantQty} gold.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} wanted to trade but you don't have enough gold.`) },
    };
  }
  if (!wantIsGold && !hasItem(target, wantItem.toLowerCase(), wantQty)) {
    return {
      event: { ...baseEvent(agent, tick), type: "trade_reject", target: targetName, result: `${targetName} doesn't have ${wantQty} ${wantItem}.` } as SimEvent,
      memoryForAgent: mem(tick, `${targetName} doesn't have ${wantQty} ${wantItem}.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} wanted your ${wantItem} but you don't have enough.`) },
    };
  }

  // Acceptance logic: relationship + deal fairness + hunger desperation
  const rel = target.relationships[agent.id] ?? 0;
  const offerValue = offerIsGold ? offerQty : (ITEM_PRICES[offerItem.toLowerCase()] ?? 3) * offerQty;
  const wantValue = wantIsGold ? wantQty : (ITEM_PRICES[wantItem.toLowerCase()] ?? 3) * wantQty;
  const fairnessRatio = offerValue / Math.max(1, wantValue); // >1 = good deal for target

  // Base acceptance: 30% + up to 30% from relationship + up to 30% from deal fairness + 20% if target is hungry and offered food
  let acceptChance = 0.3;
  acceptChance += Math.max(0, rel / 100) * 0.3; // 0-30% from relationship
  acceptChance += Math.min(0.3, (fairnessRatio - 0.5) * 0.4); // deal quality
  if (target.hunger >= 50 && FOOD_ITEMS[offerItem.toLowerCase()]) {
    acceptChance += 0.2; // desperate for food
  }
  acceptChance = Math.max(0.05, Math.min(0.95, acceptChance));

  const accepted = Math.random() < acceptChance;

  if (accepted) {
    // Execute the trade
    if (offerIsGold) { agent.gold -= offerQty; target.gold += offerQty; }
    else { removeItem(agent, offerItem.toLowerCase(), offerQty); addItem(target, offerItem.toLowerCase(), offerQty); }

    if (wantIsGold) { target.gold -= wantQty; agent.gold += wantQty; }
    else { removeItem(target, wantItem.toLowerCase(), wantQty); addItem(agent, wantItem.toLowerCase(), wantQty); }

    adjustRelationship(agent, target.id, 8);
    adjustRelationship(target, agent.id, 8);

    const tradeDesc = `${offerQty} ${offerItem} for ${wantQty} ${wantItem}`;
    return {
      event: { ...baseEvent(agent, tick), type: "trade", target: targetName, item: offerItem, result: `Traded ${tradeDesc} with ${targetName}.` } as SimEvent,
      memoryForAgent: mem(tick, `You traded ${tradeDesc} with ${targetName}. They accepted.`),
      memoryForWitnesses: mem(tick, `${agent.name} traded ${tradeDesc} with ${targetName}.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} traded you ${offerQty} ${offerItem} for your ${wantQty} ${wantItem}. You accepted.`) },
    };
  } else {
    adjustRelationship(agent, target.id, -3);
    const tradeDesc = `${offerQty} ${offerItem} for ${wantQty} ${wantItem}`;
    return {
      event: { ...baseEvent(agent, tick), type: "trade_reject", target: targetName, item: offerItem, result: `${targetName} rejected trade: ${tradeDesc}.` } as SimEvent,
      memoryForAgent: mem(tick, `You offered ${targetName} ${tradeDesc} but they refused.`),
      memoryForWitnesses: mem(tick, `${agent.name} tried to trade with ${targetName} but was refused.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} offered you ${offerQty} ${offerItem} for your ${wantQty} ${wantItem}. You refused.`) },
    };
  }
}

function resolveSteal(agent: LifeSimAgent, allAgents: LifeSimAgent[], targetName: string, item: string, tick: number): ToolResult {
  const target = findAgentByName(allAgents, targetName);
  if (!target || target.location !== agent.location) {
    return {
      event: { ...baseEvent(agent, tick), type: "steal_fail", target: targetName, result: `${targetName} is not here.` } as SimEvent,
      memoryForAgent: mem(tick, `You tried to steal from ${targetName} but they aren't here.`),
    };
  }

  const witnesses = agentsAtLocation(allAgents, agent.location, agent.id).filter(a => a.id !== target.id);
  const successChance = Math.max(0.1, 0.5 - witnesses.length * 0.1);
  const success = Math.random() < successChance;

  if (item.toLowerCase() === "gold") {
    const stealAmount = Math.min(target.gold, Math.floor(Math.random() * 10) + 3);
    if (success && stealAmount > 0) {
      target.gold -= stealAmount;
      agent.gold += stealAmount;
      return {
        event: { ...baseEvent(agent, tick), type: "steal", target: targetName, item: "gold", gold: stealAmount, result: `Stole ${stealAmount} gold from ${targetName}!` } as SimEvent,
        memoryForAgent: mem(tick, `You stole ${stealAmount} gold from ${targetName}. Nobody noticed.`),
      };
    } else {
      adjustRelationship(target, agent.id, -25);
      witnesses.forEach(w => adjustRelationship(w, agent.id, -10));
      return {
        event: { ...baseEvent(agent, tick), type: "steal_fail", target: targetName, item: "gold", result: `Caught stealing from ${targetName}!` } as SimEvent,
        memoryForAgent: mem(tick, `You tried to steal from ${targetName} but got caught!`),
        memoryForWitnesses: mem(tick, `${agent.name} was caught trying to steal from ${targetName}!`),
        targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} tried to steal from you!`) },
      };
    }
  } else {
    if (success && hasItem(target, item)) {
      removeItem(target, item, 1);
      addItem(agent, item, 1);
      return {
        event: { ...baseEvent(agent, tick), type: "steal", target: targetName, item, result: `Stole ${item} from ${targetName}!` } as SimEvent,
        memoryForAgent: mem(tick, `You stole a ${item} from ${targetName}. Nobody noticed.`),
      };
    } else {
      adjustRelationship(target, agent.id, -25);
      witnesses.forEach(w => adjustRelationship(w, agent.id, -10));
      return {
        event: { ...baseEvent(agent, tick), type: "steal_fail", target: targetName, item, result: `Caught stealing from ${targetName}!` } as SimEvent,
        memoryForAgent: mem(tick, `You tried to steal from ${targetName} but got caught!`),
        memoryForWitnesses: mem(tick, `${agent.name} was caught trying to steal from ${targetName}!`),
        targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} tried to steal from you!`) },
      };
    }
  }
}

function resolveAttack(agent: LifeSimAgent, allAgents: LifeSimAgent[], targetName: string, tick: number): ToolResult {
  if (attacksThisTurn.has(agent.id)) {
    return {
      event: { ...baseEvent(agent, tick), type: "attack", target: targetName, result: "Already attacked this turn." } as SimEvent,
      memoryForAgent: mem(tick, "You already attacked someone this turn."),
    };
  }

  const target = findAgentByName(allAgents, targetName);
  if (!target || target.location !== agent.location) {
    return {
      event: { ...baseEvent(agent, tick), type: "attack", target: targetName, result: `${targetName} is not here.` } as SimEvent,
      memoryForAgent: mem(tick, `You tried to attack ${targetName} but they aren't here.`),
    };
  }

  attacksThisTurn.add(agent.id);

  let damage = Math.floor(Math.random() * 16) + 20; // 20-35
  if (hasItem(agent, "sword")) damage += 15;

  target.health = Math.max(0, target.health - damage);
  agent.energy = Math.max(0, agent.energy - 15);

  adjustRelationship(target, agent.id, -40);
  const witnesses = agentsAtLocation(allAgents, agent.location, agent.id).filter(a => a.id !== target.id);
  witnesses.forEach(w => adjustRelationship(w, agent.id, -15));

  const result: ToolResult = {
    event: { ...baseEvent(agent, tick), type: "attack", target: targetName, damage, result: `Attacked ${targetName} for ${damage} damage! (${target.health} HP remaining)` } as SimEvent,
    memoryForAgent: mem(tick, `You attacked ${targetName} for ${damage} damage. They have ${target.health} HP left.`),
    memoryForWitnesses: mem(tick, `${agent.name} attacked ${targetName} for ${damage} damage!`),
    targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} attacked you for ${damage} damage! You have ${target.health} HP left.`) },
  };

  if (target.health <= 0) {
    target.alive = false;
    result.event.type = "death";
    result.event.result = `${targetName} has been killed by ${agent.name}!`;
    result.memoryForAgent = mem(tick, `You killed ${targetName}!`);
    result.memoryForAll = mem(tick, `${targetName} was killed by ${agent.name}!`);
  }

  return result;
}

function resolveWork(agent: LifeSimAgent, tick: number): ToolResult {
  const validLocations = WORK_LOCATIONS[agent.occupation] ?? [];
  if (!validLocations.includes(agent.location)) {
    const locNames = validLocations.map(getLocationName).join(" or ");
    return {
      event: { ...baseEvent(agent, tick), type: "work", result: `Can't work here. Go to ${locNames}.` } as SimEvent,
      memoryForAgent: mem(tick, `You can't work here as a ${agent.occupation}. You need to go to the ${locNames}.`),
    };
  }

  // Night restriction: can't work in the dark
  if (tick % 6 === 5) {
    return {
      event: { ...baseEvent(agent, tick), type: "work", result: "Too dark to work at night." } as SimEvent,
      memoryForAgent: mem(tick, "It's too dark to work. You should rest until morning."),
    };
  }

  if (agent.energy < 20) {
    return {
      event: { ...baseEvent(agent, tick), type: "work", result: "Too tired to work." } as SimEvent,
      memoryForAgent: mem(tick, "You're too exhausted to work. You need to rest or eat."),
    };
  }

  const output = WORK_OUTPUTS[agent.occupation];
  if (!output) {
    return {
      event: { ...baseEvent(agent, tick), type: "work", result: "Nothing to do." } as SimEvent,
      memoryForAgent: mem(tick, "You couldn't find any work to do."),
    };
  }

  // Blacksmith special: needs ore to forge tools
  if (agent.occupation === "blacksmith") {
    if (!hasItem(agent, "ore", 1)) {
      return {
        event: { ...baseEvent(agent, tick), type: "work", result: "Need ore to forge." } as SimEvent,
        memoryForAgent: mem(tick, "You can't forge anything without ore. You need to buy or trade for ore from a miner."),
      };
    }
    removeItem(agent, "ore", 1);
    addItem(agent, "tools", 1);
    agent.energy -= 25;
    // Tools bonus: having tools makes work more productive for everyone
    return {
      event: { ...baseEvent(agent, tick), type: "work", item: "tools", quantity: 1, result: "Forged 1 tools from ore." } as SimEvent,
      memoryForAgent: mem(tick, `You forged 1 tools from ore. Energy: ${agent.energy}. Others will want these — tools make work more productive.`),
      memoryForWitnesses: mem(tick, `${agent.name} forged tools at the smithy.`),
    };
  }

  // All other occupations
  agent.energy -= 20;

  if (output.item === "gold") {
    // Service occupations earn gold directly
    const earned = Math.floor(Math.random() * (output.maxQty - output.minQty + 1)) + output.minQty;
    // Tools bonus: +50% gold if agent has tools
    const bonus = hasItem(agent, "tools") ? Math.ceil(earned * 0.5) : 0;
    const total = earned + bonus;
    agent.gold += total;
    const bonusStr = bonus > 0 ? ` (+${bonus} from tools)` : "";

    return {
      event: { ...baseEvent(agent, tick), type: "work", gold: total, result: `Earned ${total} gold from ${agent.occupation} work${bonusStr}.` } as SimEvent,
      memoryForAgent: mem(tick, `You earned ${total} gold as a ${agent.occupation}${bonusStr}. Energy: ${agent.energy}.`),
    };
  } else {
    // Production occupations produce goods
    let qty = Math.floor(Math.random() * (output.maxQty - output.minQty + 1)) + output.minQty;
    // Tools bonus: +1 item if agent has tools
    if (hasItem(agent, "tools")) qty += 1;
    addItem(agent, output.item, qty);

    return {
      event: { ...baseEvent(agent, tick), type: "work", item: output.item, quantity: qty, result: `Produced ${qty} ${output.item} from ${agent.occupation} work.` } as SimEvent,
      memoryForAgent: mem(tick, `You produced ${qty} ${output.item}. Energy: ${agent.energy}. You could eat, sell, or trade these.`),
    };
  }
}

function resolveBuy(agent: LifeSimAgent, item: string, quantity: number, tick: number): ToolResult {
  const loc = LOCATIONS.find(l => l.id === agent.location);
  if (!loc || (loc.type !== "market" && loc.type !== "blacksmith")) {
    return {
      event: { ...baseEvent(agent, tick), type: "buy", item, result: "Not at a shop." } as SimEvent,
      memoryForAgent: mem(tick, "You need to be at the Market or Blacksmith to buy things."),
    };
  }

  const price = ITEM_PRICES[item.toLowerCase()];
  if (!price) {
    return {
      event: { ...baseEvent(agent, tick), type: "buy", item, result: `Unknown item: ${item}` } as SimEvent,
      memoryForAgent: mem(tick, `"${item}" is not available for purchase.`),
    };
  }

  const totalCost = price * quantity;
  if (agent.gold < totalCost) {
    return {
      event: { ...baseEvent(agent, tick), type: "buy", item, result: `Not enough gold. Need ${totalCost}, have ${agent.gold}.` } as SimEvent,
      memoryForAgent: mem(tick, `You can't afford ${quantity} ${item} (costs ${totalCost} gold, you have ${agent.gold}).`),
    };
  }

  agent.gold -= totalCost;
  addItem(agent, item.toLowerCase(), quantity);

  return {
    event: { ...baseEvent(agent, tick), type: "buy", item, quantity, gold: totalCost, result: `Bought ${quantity} ${item} for ${totalCost} gold.` } as SimEvent,
    memoryForAgent: mem(tick, `You bought ${quantity} ${item} for ${totalCost} gold. Gold remaining: ${agent.gold}.`),
  };
}

function resolveSell(agent: LifeSimAgent, item: string, quantity: number, tick: number): ToolResult {
  const loc = LOCATIONS.find(l => l.id === agent.location);
  if (!loc || loc.type !== "market") {
    return {
      event: { ...baseEvent(agent, tick), type: "sell", item, result: "Not at the market." } as SimEvent,
      memoryForAgent: mem(tick, "You need to be at the Market to sell things."),
    };
  }

  if (!removeItem(agent, item.toLowerCase(), quantity)) {
    return {
      event: { ...baseEvent(agent, tick), type: "sell", item, result: `You don't have ${quantity} ${item}.` } as SimEvent,
      memoryForAgent: mem(tick, `You don't have ${quantity} ${item} to sell.`),
    };
  }

  const basePrice = ITEM_PRICES[item.toLowerCase()] ?? 3;
  const sellPrice = Math.max(1, Math.floor(basePrice * 0.6));
  const totalGold = sellPrice * quantity;
  agent.gold += totalGold;

  return {
    event: { ...baseEvent(agent, tick), type: "sell", item, quantity, gold: totalGold, result: `Sold ${quantity} ${item} for ${totalGold} gold.` } as SimEvent,
    memoryForAgent: mem(tick, `You sold ${quantity} ${item} for ${totalGold} gold. Gold: ${agent.gold}.`),
  };
}

// ── Eat food ────────────────────────────────────────────────────────────────

function resolveEat(agent: LifeSimAgent, itemName: string, tick: number): ToolResult {
  const item = itemName.toLowerCase();
  const hungerRelief = FOOD_ITEMS[item];

  if (!hungerRelief) {
    return {
      event: { ...baseEvent(agent, tick), type: "eat", item, result: `${itemName} is not edible.` } as SimEvent,
      memoryForAgent: mem(tick, `You can't eat ${itemName}. Edible food: bread, meat, fish, wheat, ale.`),
    };
  }

  if (!hasItem(agent, item)) {
    return {
      event: { ...baseEvent(agent, tick), type: "eat", item, result: `You don't have ${itemName}.` } as SimEvent,
      memoryForAgent: mem(tick, `You wanted to eat ${itemName} but you don't have any. You're ${hungerDesc(agent.hunger)}.`),
    };
  }

  removeItem(agent, item, 1);
  const oldHunger = agent.hunger;
  agent.hunger = Math.max(0, agent.hunger - hungerRelief);
  // Eating also restores a little energy
  agent.energy = Math.min(100, agent.energy + 10);

  return {
    event: { ...baseEvent(agent, tick), type: "eat", item, result: `Ate ${itemName}. Hunger: ${oldHunger} → ${agent.hunger}.` } as SimEvent,
    memoryForAgent: mem(tick, `You ate ${itemName}. Hunger went from ${oldHunger} to ${agent.hunger}. You feel ${hungerDesc(agent.hunger)}.`),
    memoryForWitnesses: mem(tick, `${agent.name} ate some ${itemName}.`),
  };
}

function resolveRest(agent: LifeSimAgent, tick: number): ToolResult {
  let recovery = 20;
  const loc = LOCATIONS.find(l => l.id === agent.location);

  if (agent.location === agent.home) {
    recovery = 40;
  } else if (loc?.type === "tavern") {
    if (agent.gold >= 2) {
      agent.gold -= 2;
      recovery = 35;
    } else {
      recovery = 15;
    }
  }

  agent.energy = Math.min(100, agent.energy + recovery);

  return {
    event: { ...baseEvent(agent, tick), type: "rest", result: `Rested and recovered ${recovery} energy. Energy: ${agent.energy}.` } as SimEvent,
    memoryForAgent: mem(tick, `You rested and recovered ${recovery} energy. Energy: ${agent.energy}/100.`),
  };
}

function resolvePropose(agent: LifeSimAgent, allAgents: LifeSimAgent[], targetName: string, tick: number): ToolResult {
  const target = findAgentByName(allAgents, targetName);
  if (!target || target.location !== agent.location) {
    return {
      event: { ...baseEvent(agent, tick), type: "propose", target: targetName, result: `${targetName} is not here.` } as SimEvent,
      memoryForAgent: mem(tick, `You tried to propose to ${targetName} but they aren't here.`),
    };
  }

  if (agent.spouse) {
    return {
      event: { ...baseEvent(agent, tick), type: "propose", target: targetName, result: "You are already married." } as SimEvent,
      memoryForAgent: mem(tick, "You are already married!"),
    };
  }
  if (target.spouse) {
    return {
      event: { ...baseEvent(agent, tick), type: "propose_rejected", target: targetName, result: `${targetName} is already married.` } as SimEvent,
      memoryForAgent: mem(tick, `${targetName} is already married.`),
    };
  }

  const rel = target.relationships[agent.id] ?? 0;
  const acceptChance = rel >= 30 ? Math.min(0.9, (rel - 20) / 80) : 0.05;
  const accepted = Math.random() < acceptChance;

  if (accepted) {
    agent.spouse = target.id;
    target.spouse = agent.id;
    adjustRelationship(agent, target.id, 30);
    adjustRelationship(target, agent.id, 30);

    return {
      event: { ...baseEvent(agent, tick), type: "propose_accepted", target: targetName, result: `${targetName} accepted ${agent.name}'s proposal!` } as SimEvent,
      memoryForAgent: mem(tick, `You proposed to ${targetName} and they said yes! You are now married!`),
      memoryForWitnesses: mem(tick, `${agent.name} proposed to ${targetName} and they said yes!`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} proposed to you and you said yes! You are now married!`) },
    };
  } else {
    adjustRelationship(agent, target.id, -10);

    return {
      event: { ...baseEvent(agent, tick), type: "propose_rejected", target: targetName, result: `${targetName} rejected ${agent.name}'s proposal.` } as SimEvent,
      memoryForAgent: mem(tick, `You proposed to ${targetName} but they rejected you.`),
      memoryForWitnesses: mem(tick, `${agent.name} proposed to ${targetName} but was rejected.`),
      targetMemory: { targetId: target.id, text: mem(tick, `${agent.name} proposed to you but you declined.`) },
    };
  }
}
