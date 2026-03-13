// ── Life Sim Types ─────────────────────────────────────────────────────────

export type Occupation = "farmer" | "blacksmith" | "merchant" | "priest" | "bard" | "hunter" | "miner";

export interface InventoryItem {
  name: string;
  quantity: number;
}

export interface LifeSimAgent {
  id: string;
  name: string;
  personality: string;
  occupation: Occupation;
  color: string;

  // Stats
  health: number;       // 0–100
  energy: number;       // 0–100
  hunger: number;       // 0–100 (0 = full, 100 = starving)
  gold: number;

  // State
  alive: boolean;
  location: string;     // location id
  home: string;         // location id
  spouse: string | null; // agent id
  inventory: InventoryItem[];

  // Relationships: agentId -> -100..100
  relationships: Record<string, number>;

  // Memory: last N events witnessed
  memory: string[];
}

export type LocationType =
  | "village_square"
  | "market"
  | "tavern"
  | "church"
  | "blacksmith"
  | "farm"
  | "forest"
  | "river"
  | "mine"
  | "house";

export type BuildingType = "tavern" | "church" | "house" | "blacksmith" | "market" | "farm_building" | "mine_entrance";

export interface Location {
  id: string;
  name: string;
  type: LocationType;
  // Tile position (center of the location on the map grid)
  x: number;
  y: number;
  // Pixel positions where agents can stand (offset from location center)
  spawnOffsets: { dx: number; dy: number }[];
  // Building overlay info (if this location has a building)
  buildingType?: BuildingType;
  buildingSize?: { w: number; h: number }; // in tiles
}

export type SimEventType =
  | "move"
  | "say"
  | "give"
  | "steal"
  | "steal_fail"
  | "attack"
  | "death"
  | "work"
  | "buy"
  | "sell"
  | "trade"
  | "trade_reject"
  | "eat"
  | "rest"
  | "propose"
  | "propose_accepted"
  | "propose_rejected"
  | "system"
  | "observe"
  | "starving";

export interface SimEvent {
  id: string;
  tick: number;
  agentId: string;
  agentName: string;
  type: SimEventType;
  location: string;
  target?: string;       // target agent name
  item?: string;
  quantity?: number;
  message?: string;      // for say events
  result?: string;       // tool result text
  gold?: number;         // for work/buy/sell
  damage?: number;       // for attack
  timestamp: number;
}

// ── Tool calling types ─────────────────────────────────────────────────────

export interface ToolAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentTurnResult {
  thought?: string;
  actions: ToolAction[];
}

// ── Run record ─────────────────────────────────────────────────────────────

export interface LifeSimRunRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  tickCount: number;
  model: string;
  temperature: number;
  agentCount: number;
  agents: LifeSimAgent[];
  events: SimEvent[];
  // Snapshot of initial agent state for replay
  initialAgents: LifeSimAgent[];
}
