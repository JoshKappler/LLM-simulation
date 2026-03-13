export type GamePhase = "chat" | "tribal_council" | "endgame" | "finished";

export interface ColonyAgent {
  id: string;
  name: string;
  trait: string;
  alive: boolean;
  joinedAt: number;
  eliminatedAt?: number;
  color: string;
}

export interface ColonyMessage {
  id: string;
  type: "chat" | "system" | "vote_result" | "defense" | "nomination_result";
  agentId?: string;
  agentName: string;
  content: string;
  turn: number;
}

export interface VoteRecord {
  voterId: string;
  voterName: string;
  targetName: string;
  type: "nomination" | "elimination" | "jury";
}
