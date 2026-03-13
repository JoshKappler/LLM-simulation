export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: string;
  role?: "character" | "killer" | "narrator";
  primer?: string; // silent first assistant turn injected to prime format
  numPredict?: number; // per-agent token limit override; falls back to global if unset
  // Per-character overrides. When undefined, the global value is used instead.
  guidelinesOverride?: string;
  situationOverride?: string;
}

export interface ConversationTurn {
  agentIndex: number;
  agentName: string;
  content: string;
  isStreaming: boolean;
  systemPrompt?: string; // assembled system prompt sent for this turn
}

export interface PromptConfig {
  name: string;
  characters?: AgentConfig[];
  guidelines?: string;
  situation: string;
  promptBlockOrder?: string[]; // e.g. ["guidelines","identity","situation"]
  savedAt: string;
  // Legacy fields for backward compat
  agentA?: AgentConfig;
  agentB?: AgentConfig;
}

export interface ChatChunk {
  type?: string;
  retryMs?: number;
  retrySecs?: number;
  message?: { role: string; content: string };
  done: boolean;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: { role: string; content: string }[];
  temperature: number;
  numPredict?: number;
  minP?: number;
  stop?: string[];
}

export interface PersonalityPreset {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  isBuiltIn?: boolean;
  role?: "character" | "killer" | "narrator";
  primer?: string;
}

export interface SituationPreset {
  id: string;
  name: string;
  description: string;
  situation: string;
  guidelines?: string;
  openingLine?: string;
  promptBlockOrder?: string[]; // e.g. ["guidelines","identity","situation"]
  isBuiltIn?: boolean;
}

export interface GuidelinesPreset {
  id: string;
  name: string;
  guidelines: string;
  isBuiltIn?: boolean;
}

export interface RunSummary {
  id: string;
  savedAt: string;
  agentAName: string;
  agentBName: string;
  turnCount: number;
  situationSnippet: string;
}

// ── Optimizer types ───────────────────────────────────────────────────────────

export interface RatingDimension {
  score: number; // 0–10
  notes: string;
}

export interface RatingResult {
  emotionalAuthenticity: RatingDimension;
  naturalDialogue: RatingDimension;
  dramaticTensionArc: RatingDimension;
  scenarioCoherence: RatingDimension;
  organicResolution: RatingDimension;
  total: number; // sum 0–50
  summary: string;
  flags: string[];
  diagnosis: string; // 2-3 weakest moments: quoted lines traced to prompt problems
}

export interface PromptViolation {
  field: string;
  characterName?: string;
  violation: string;
  quotedText: string;
  severity: "minor" | "moderate" | "critical";
}

export interface CausalDiagnosis {
  promptQuote: string;
  transcriptQuote: string;
  explanation: string;
  promptFixable: boolean;
}

export interface AuditResult {
  violations: PromptViolation[];
  diagnoses: CausalDiagnosis[];
  rating: RatingResult;
}

export type MutationField =
  | "situation"
  | "character_0"
  | "character_1"
  | "character_killer"
  | "guidelines"
  | "seed"
  | "crossover"
  | "rewrite"
  | "targeted_fix"
  | "explore"
  | "parent_copy";

export interface RatedConfig {
  config: PromptConfig;
  runId: string;
  turns: ConversationTurn[];
  rating: RatingResult | null;
  turnCount: number;
  generationIndex: number;
  variantIndex: number;
  mutationField: MutationField;
  mutationQuality?: "ok" | "suspect";
  parentConfigName?: string;
  terminationReason?: string;
  isCarryover?: boolean;
  effectiveScore?: number;
  changeDescription?: string; // brief summary of what changed vs parent
  audit?: AuditResult; // prompt compliance audit + causal diagnosis
}

export interface GenerationRecord {
  index: number;
  startedAt: string;
  completedAt?: string;
  complete?: boolean;
  variants: RatedConfig[];
  eliteIndex: number;
}

export interface OptimizationJob {
  id: string;
  seedConfigName: string;
  seedConfig: PromptConfig;
  createdAt: string;
  completedAt?: string;
  status: "running" | "stopped" | "complete" | "error";
  currentGeneration: number;
  maxGenerations: number;
  variantsPerGeneration: number;
  maxTurnsPerRun: number;
  temperature: number;
  judgeModel: string;
  mutationModel: string;
  characterModel?: string; // overrides model for all roleplay agents; falls back to config's own model
  population: RatedConfig[]; // top 10 all-time by score
  pendingRewrites?: PromptConfig[]; // targeted fixes from auditAndRate, used as variants in next gen
  stopFlag?: boolean;
  lastError?: string;
}

export interface OptimizationEvent {
  type:
    | "turn_complete"
    | "turn_token"
    | "run_start"
    | "run_complete"
    | "rating_complete"
    | "mutation_complete"
    | "generation_complete"
    | "job_complete"
    | "error"
    | "evaluator_token";
  jobId: string;
  generation?: number;
  variant?: number;
  mutationField?: MutationField;
  isCarryover?: boolean;
  turn?: ConversationTurn;
  runId?: string;
  turnCount?: number;
  rating?: RatingResult | null;
  elite?: { total: number; summary: string; mutationField: MutationField };
  message?: string;
  // evaluator_token fields
  token?: string;
  phase?: string; // "evaluate" | "bootstrap" — which evaluator phase is streaming
  // turn_token fields
  agentIndex?: number;
  agentName?: string;
}

export interface EvolutionPreset {
  id: string;
  name: string;
  description: string;
  seedConfigName: string;
  maxGenerations: number;
  variantsPerGeneration: number;
  maxTurnsPerRun: number;
  temperature: number;
  judgeModel: string;
  mutationModel: string;
  characterModel: string;
}

export interface JobSummary {
  id: string;
  seedConfigName: string;
  createdAt: string;
  status: OptimizationJob["status"];
  currentGeneration: number;
  maxGenerations: number;
  bestScore: number | null;
}

export interface RunRecord extends RunSummary {
  characters?: AgentConfig[];
  agentA?: AgentConfig;
  agentB?: AgentConfig;
  situation: string;
  guidelines?: string;
  openingLine?: string;
  temperature?: number;
  promptBlockOrder?: string[];
  numPredict?: number;
  minP?: number;
  contextWindow?: number;
  turns: ConversationTurn[];
}
