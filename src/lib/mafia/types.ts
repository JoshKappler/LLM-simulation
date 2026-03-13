export type MafiaRole = "villager" | "wolf" | "doctor" | "detective";

export interface MafiaPlayer {
  id: string;
  name: string;
  personality: string;
  role: MafiaRole;
  alive: boolean;
  color: string;
}

export interface MafiaMessage {
  id: string;
  round: number;
  phase: "day" | "vote" | "night" | "wolf-chat" | "doctor" | "detective" | "system" | "reaction" | "wolf-strategy";
  playerId?: string;
  playerName: string;
  content: string;
  systemPrompt?: string;
}

export interface MafiaRunRecord {
  id: string;
  savedAt: string;
  players: MafiaPlayer[];
  messages: MafiaMessage[];
  winner: "villagers" | "wolves" | null;
  roundCount: number;
  model: string;
  temperature: number;
}

export interface MafiaVote {
  voterId: string;
  voterName: string;
  targetName: string;
}

export interface MafiaGameConfig {
  playerCount: number;
  wolfCount: number;
  maxRounds: number;
  model: string;
  temperature: number;
}

export interface MafiaPreset {
  name: string;
  personality: string;
}
