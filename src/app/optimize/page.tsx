"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ConversationTurn,
  OptimizationJob,
  OptimizationEvent,
  RatedConfig,
  JobSummary,
  GenerationRecord,
} from "@/lib/types";

const AGENT_COLORS = ["#000099", "#990000", "#555555", "#006600", "#880088"];
const AGENT_BG = ["#f0f4ff", "#fff2f2", "#e8e8e8", "#f0fff0", "#f8f0ff"];

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreColor(score: number | null): string {
  if (score === null) return "#808080";
  if (score >= 40) return "#006600";
  if (score >= 30) return "#886600";
  return "#880000";
}

function ScoreBar({ value, max = 10 }: { value: number; max?: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ flex: 1, height: 8, background: "#c0c0c0", border: "1px solid #808080" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: scoreColor(value * 5) }} />
      </div>
      <span style={{ fontSize: 10, minWidth: 16, textAlign: "right" }}>{value}</span>
    </div>
  );
}

// ── W95 Slider (matches home page) ────────────────────────────────────────────

function W95Slider({
  min, max, step, value, onChange,
}: {
  min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  function valueFromClientX(clientX: number) {
    const rect = trackRef.current!.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + pct * (max - min);
    return parseFloat((Math.round(raw / step) * step).toFixed(2));
  }

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    onChange(valueFromClientX(e.clientX));
    const onMove = (ev: MouseEvent) => onChange(valueFromClientX(ev.clientX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown}
      style={{
        position: "relative", height: 24, flex: 1,
        display: "flex", alignItems: "center", cursor: "pointer", userSelect: "none",
      }}
    >
      <div style={{
        position: "absolute", left: 0, right: 0, height: 4,
        background: "#808080",
        borderTop: "1px solid #404040", borderLeft: "1px solid #404040",
        borderBottom: "1px solid #ffffff", borderRight: "1px solid #ffffff",
      }} />
      <div style={{
        position: "absolute",
        left: `${pct}%`,
        transform: "translateX(-50%)",
        width: 11, height: 21,
        background: "#c0c0c0",
        borderStyle: "solid", borderWidth: 2,
        borderColor: "#ffffff #808080 #808080 #ffffff",
        boxSizing: "border-box",
      }} />
    </div>
  );
}

// ── Mutation badge ─────────────────────────────────────────────────────────────

const MUT_COLORS: Record<string, string> = {
  seed: "#555555",
  situation: "#006600",
  character_0: "#000099",
  character_1: "#880000",
  character_killer: "#555500",
  guidelines: "#886600",
  crossover: "#880088",
};

function MutBadge({ field }: { field: string }) {
  const color = MUT_COLORS[field] ?? "#555";
  const label = field === "seed" || field === "crossover" ? field : "mutated";
  return (
    <span style={{
      display: "inline-block", padding: "1px 5px", fontSize: 9, fontWeight: "bold",
      background: color, color: "#fff", borderRadius: 2, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

// ── Transcript dialog ──────────────────────────────────────────────────────────

function TranscriptDialog({ variant, onClose }: { variant: RatedConfig; onClose: () => void }) {
  const names = (variant.config.characters ?? []).map((c) => c.name);
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        className="w95-raise"
        style={{ width: "min(720px, 92vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", background: "#c0c0c0" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w95-titlebar">
          <span>Transcript — {variant.config.name}</span>
          <div className="w95-winctrls">
            <button className="w95-winbtn" onClick={onClose}>✕</button>
          </div>
        </div>

        {variant.rating && (
          <div style={{ padding: "6px 8px", background: "#f0f0f0", borderBottom: "1px solid #808080", fontSize: 11 }}>
            <div style={{ fontWeight: "bold", marginBottom: 3, color: scoreColor(variant.rating.total) }}>
              Score: {variant.rating.total}/50 — {variant.rating.summary}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "2px 8px" }}>
              {(["emotionalAuthenticity", "naturalDialogue", "dramaticTensionArc", "scenarioCoherence", "organicResolution"] as const).map((k) => (
                <div key={k}>
                  <div style={{ fontSize: 10, color: "#666" }}>
                    {k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                  </div>
                  <ScoreBar value={variant.rating![k].score} />
                </div>
              ))}
            </div>
            {variant.rating.flags.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#880000" }}>
                Flags: {variant.rating.flags.join(", ")}
              </div>
            )}
          </div>
        )}

        <div className="aol-chat w95-deep-inset w95-scrollable" style={{ flex: 1, overflowY: "auto" }}>
          {variant.turns.filter((t) => !t.isStreaming && t.content.trim()).map((turn, i) => {
            const nameIdx = names.indexOf(turn.agentName);
            const colorIdx = nameIdx >= 0 ? nameIdx : turn.agentIndex;
            return (
              <div key={i} className="aol-msg" style={{ background: AGENT_BG[colorIdx % AGENT_BG.length] }}>
                <span style={{ color: AGENT_COLORS[colorIdx % AGENT_COLORS.length], fontWeight: "bold", fontSize: 11 }}>{turn.agentName}: </span>
                <span style={{ fontSize: 12 }}>{turn.content}</span>
              </div>
            );
          })}
          {variant.turns.filter((t) => !t.isStreaming).length === 0 && (
            <div className="aol-msg aol-msg-system">No turns recorded.</div>
          )}
        </div>

        <div style={{ padding: "4px 6px", display: "flex", justifyContent: "flex-end", borderTop: "1px solid #808080" }}>
          <button className="w95-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Level 3: Variants ──────────────────────────────────────────────────────────

function VariantsView({
  gen,
  onBack,
  onViewTranscript,
}: {
  gen: GenerationRecord;
  onBack: () => void;
  onViewTranscript: (v: RatedConfig) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const bestScore = gen.variants.reduce((b, v) => Math.max(b, v.rating?.total ?? -1), -1);

  return (
    <div style={{ fontSize: 11 }}>
      {/* Panel label */}
      <div style={{ padding: "4px 8px", background: "#000080", color: "#fff", fontWeight: "bold", fontSize: 11, letterSpacing: 0.5 }}>
        Variants
      </div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#e0e0e0", borderBottom: "1px solid #808080" }}>
        <button className="w95-btn" style={{ padding: "1px 6px", minWidth: "unset", fontSize: 10 }} onClick={onBack}>
          ← Gens
        </button>
        <span style={{ fontWeight: "bold" }}>Generation {gen.index} prompts</span>
        <span style={{ color: "#666", fontSize: 10 }}>{gen.variants.length} variants</span>
        {bestScore >= 0 && (
          <span style={{ marginLeft: "auto", fontWeight: "bold", color: scoreColor(bestScore), fontSize: 10 }}>
            Best: {bestScore}/50
          </span>
        )}
      </div>

      {/* Variant rows */}
      {gen.variants.map((v, vi) => {
        const isElite = vi === gen.eliteIndex;
        const isOpen = expanded === vi;
        const r = v.rating;

        return (
          <div key={vi} style={{ borderBottom: "1px solid #e0e0e0" }}>
            {/* Row */}
            <div
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "5px 8px", cursor: "pointer",
                background: isElite ? "#fffbe6" : vi % 2 === 0 ? "#fff" : "#f8f8f8",
              }}
              onClick={() => setExpanded(isOpen ? null : vi)}
            >
              {isElite && <span style={{ color: "#886600", fontSize: 11 }}>★</span>}
              <MutBadge field={v.mutationField} />
              {v.isCarryover && (
                <span style={{ fontSize: 9, color: "#808080", fontStyle: "italic" }}>↩ carried</span>
              )}
              <span style={{ fontWeight: "bold", fontSize: 10, minWidth: 38, textAlign: "right", color: scoreColor(r?.total ?? null) }}>
                {r ? `${r.total}/50` : "—"}
              </span>
              {v.effectiveScore !== undefined && v.effectiveScore > 0 && v.effectiveScore !== r?.total && (
                <span style={{ fontSize: 9, color: "#808080" }}>eff:{v.effectiveScore}</span>
              )}
              <span style={{ color: "#666", fontSize: 10 }}>{v.turnCount}t</span>
              <span style={{ flex: 1, color: v.terminationReason === "error" ? "#880000" : "#888", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {v.terminationReason === "error" ? "ollama error" : (v.terminationReason ?? "")}
              </span>
              <span style={{ fontSize: 10, color: "#808080" }}>{isOpen ? "▲" : "▼"}</span>
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div style={{ padding: "6px 10px 10px", background: "#f4f4f4", borderTop: "1px solid #ddd" }}>
                {/* Rating breakdown */}
                {r && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontWeight: "bold", fontSize: 10, color: scoreColor(r.total), marginBottom: 3 }}>
                      {r.total}/50 — {r.summary}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "2px 6px" }}>
                      {(["emotionalAuthenticity", "naturalDialogue", "dramaticTensionArc", "scenarioCoherence", "organicResolution"] as const).map((k) => (
                        <div key={k}>
                          <div style={{ fontSize: 9, color: "#666" }}>
                            {k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                          </div>
                          <ScoreBar value={r![k].score} />
                        </div>
                      ))}
                    </div>
                    {r.flags.length > 0 && (
                      <div style={{ marginTop: 2, fontSize: 9, color: "#880000" }}>
                        Flags: {r.flags.join(", ")}
                      </div>
                    )}
                  </div>
                )}

                {/* Prompt text with mutation highlight */}
                {/* Situation */}
                {(() => {
                  const text = v.config.situation ?? "";
                  if (!text) return null;
                  const isMutated = v.mutationField === "situation";
                  return (
                    <div key="situation" style={{ marginTop: 5 }}>
                      <div style={{ fontSize: 10, fontWeight: "bold", marginBottom: 2, color: isMutated ? (MUT_COLORS[v.mutationField] ?? "#333") : "#555" }}>
                        Situation{isMutated ? " (mutated)" : ""}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 10, whiteSpace: "pre-wrap", background: isMutated ? "#fffbe6" : "#f0f0f0", border: `1px solid ${isMutated ? "#ccaa00" : "#c0c0c0"}`, padding: "4px 6px", lineHeight: 1.4 }}>
                        {text}
                      </div>
                    </div>
                  );
                })()}
                {/* Characters (dynamic — shows all including killer) */}
                {(v.config.characters ?? []).map((char, ci) => {
                  const text = char.systemPrompt ?? "";
                  if (!text) return null;
                  const isKiller = char.role === "killer";
                  const mutField = isKiller
                    ? "character_killer"
                    : ci === 0 ? "character_0" : "character_1";
                  const roleLabel = isKiller
                    ? `Killer (${char.name})`
                    : ci === 0 ? `Character A (${char.name})` : `Character B (${char.name})`;
                  const isMutated =
                    v.mutationField === mutField ||
                    (v.mutationField === "crossover" && ci === 1);
                  return (
                    <div key={`char-${ci}`} style={{ marginTop: 5 }}>
                      <div style={{ fontSize: 10, fontWeight: "bold", marginBottom: 2, color: isMutated ? (MUT_COLORS[v.mutationField] ?? "#333") : "#555" }}>
                        {roleLabel}{isMutated ? " (mutated)" : ""}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 10, whiteSpace: "pre-wrap", background: isMutated ? "#fffbe6" : "#f0f0f0", border: `1px solid ${isMutated ? "#ccaa00" : "#c0c0c0"}`, padding: "4px 6px", lineHeight: 1.4 }}>
                        {text}
                      </div>
                    </div>
                  );
                })}
                {/* Guidelines */}
                {v.config.guidelines && (() => {
                  const isMutated = v.mutationField === "guidelines";
                  return (
                    <div key="guidelines" style={{ marginTop: 5 }}>
                      <div style={{ fontSize: 10, fontWeight: "bold", marginBottom: 2, color: isMutated ? (MUT_COLORS[v.mutationField] ?? "#333") : "#555" }}>
                        Guidelines{isMutated ? " (mutated)" : ""}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 10, whiteSpace: "pre-wrap", background: isMutated ? "#fffbe6" : "#f0f0f0", border: `1px solid ${isMutated ? "#ccaa00" : "#c0c0c0"}`, padding: "4px 6px", lineHeight: 1.4 }}>
                        {v.config.guidelines}
                      </div>
                    </div>
                  );
                })()}

                <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                  <button className="w95-btn" style={{ fontSize: 10, padding: "1px 8px" }} onClick={() => onViewTranscript(v)}>
                    View Transcript
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Level 2: Generations ───────────────────────────────────────────────────────

function GenerationsView({
  jobDetail,
  jobRunLabel,
  onBack,
  onSelectGen,
}: {
  jobDetail: { job: OptimizationJob; generations: GenerationRecord[] } | null;
  jobRunLabel: string;
  onBack: () => void;
  onSelectGen: (idx: number) => void;
}) {
  if (!jobDetail) {
    return (
      <div style={{ fontSize: 11 }}>
        <div style={{ padding: "4px 8px", background: "#000080", color: "#fff", fontWeight: "bold", fontSize: 11, letterSpacing: 0.5 }}>
          Generations
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#e0e0e0", borderBottom: "1px solid #808080" }}>
          <button className="w95-btn" style={{ padding: "1px 6px", minWidth: "unset", fontSize: 10 }} onClick={onBack}>← Runs</button>
          <span style={{ color: "#808080", fontStyle: "italic" }}>Loading...</span>
        </div>
      </div>
    );
  }

  const { job, generations } = jobDetail;
  const isRunning = job.status === "running";

  return (
    <div style={{ fontSize: 11 }}>
      {/* Panel label */}
      <div style={{ padding: "4px 8px", background: "#000080", color: "#fff", fontWeight: "bold", fontSize: 11, letterSpacing: 0.5 }}>
        Generations
      </div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#e0e0e0", borderBottom: "1px solid #808080" }}>
        <button className="w95-btn" style={{ padding: "1px 6px", minWidth: "unset", fontSize: 10 }} onClick={onBack}>← Runs</button>
        <span style={{ fontWeight: "bold" }}>{jobRunLabel}</span>
        {isRunning && <span style={{ fontSize: 10, color: "#006600", fontWeight: "bold" }}>● running</span>}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#666" }}>Gen {job.currentGeneration}/{job.maxGenerations}</span>
      </div>

      {generations.length === 0 ? (
        <div style={{ padding: 8, color: "#808080", fontStyle: "italic" }}>
          {isRunning ? "Running first generation..." : "No generations recorded."}
        </div>
      ) : (
        [...generations].reverse().map((gen) => {
          const bestScore = gen.variants.reduce((b, v) => Math.max(b, v.rating?.total ?? -1), -1);
          const elite = gen.variants[gen.eliteIndex];
          const originalIdx = generations.indexOf(gen);
          return (
            <div
              key={gen.index}
              style={{ padding: "6px 8px", borderBottom: "1px solid #ddd", cursor: "pointer" }}
              onClick={() => onSelectGen(originalIdx)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                <span style={{ fontWeight: "bold" }}>Gen {gen.index}</span>
                <span style={{ color: "#666", fontSize: 10 }}>{gen.variants.length} variants</span>
                {isRunning && !gen.completedAt && (
                  <span style={{ fontSize: 9, color: "#006600", fontWeight: "bold" }}>● in progress</span>
                )}
                <span style={{ marginLeft: "auto", fontWeight: "bold", color: scoreColor(bestScore), fontSize: 10 }}>
                  {bestScore >= 0 ? `${bestScore}/50` : "—"}
                </span>
              </div>
              {elite?.rating && (
                <div style={{ fontSize: 10, color: "#555", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span>★</span>
                  <MutBadge field={elite.mutationField} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {elite.rating.summary?.slice(0, 90) ?? ""}
                  </span>
                </div>
              )}
              <div style={{ fontSize: 10, color: "#aaa", marginTop: 1 }}>{fmtDate(gen.completedAt ?? gen.startedAt)}</div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Level 1: Evolution runs ────────────────────────────────────────────────────

function JobsView({
  jobs,
  activeJobId,
  sortMode,
  onSortChange,
  onSelectJob,
}: {
  jobs: JobSummary[];
  activeJobId: string | null;
  sortMode: "recent" | "score";
  onSortChange: (mode: "recent" | "score") => void;
  onSelectJob: (id: string) => void;
}) {
  const sorted = [...jobs].sort((a, b) =>
    sortMode === "score"
      ? (b.bestScore ?? -1) - (a.bestScore ?? -1)
      : b.createdAt > a.createdAt ? 1 : -1,
  );

  return (
    <div style={{ fontSize: 11 }}>
      {/* Panel label */}
      <div style={{ padding: "4px 8px", background: "#000080", color: "#fff", fontWeight: "bold", fontSize: 11, letterSpacing: 0.5 }}>
        Evolution Runs
      </div>
      {/* Sort controls */}
      <div style={{ padding: "4px 8px", background: "#e8e8e8", borderBottom: "1px solid #c0c0c0", display: "flex", gap: 4, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: "#555" }}>Sort:</span>
        {(["recent", "score"] as const).map((mode) => (
          <button
            key={mode}
            className="w95-btn"
            style={{
              fontSize: 10, padding: "1px 8px", minWidth: "unset",
              background: sortMode === mode ? "#000080" : "#c0c0c0",
              color: sortMode === mode ? "#fff" : "#000",
            }}
            onClick={() => onSortChange(mode)}
          >
            {mode === "recent" ? "Recent" : "Best Score"}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div style={{ padding: 8, color: "#808080", fontStyle: "italic" }}>No evolution runs yet. Start a job above.</div>
      ) : (
        (() => {
          // Number runs with the same seedConfigName chronologically (oldest = #1)
          const byName: Record<string, string[]> = {};
          [...jobs].sort((a, b) => a.createdAt > b.createdAt ? 1 : -1).forEach((j) => {
            byName[j.seedConfigName] = byName[j.seedConfigName] ?? [];
            byName[j.seedConfigName].push(j.id);
          });
          return sorted.map((j) => {
            const siblings = byName[j.seedConfigName];
            const runNum = siblings.length > 1 ? ` #${siblings.indexOf(j.id) + 1}` : "";
            return (
          <div
            key={j.id}
            style={{
              padding: "6px 8px", borderBottom: "1px solid #ddd", cursor: "pointer",
              background: j.id === activeJobId ? "#e0e8ff" : "transparent",
            }}
            onClick={() => onSelectJob(j.id)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
              {j.status === "running" && <span style={{ color: "#006600", fontSize: 10 }}>●</span>}
              <span style={{ fontWeight: "bold" }}>{j.seedConfigName}{runNum}</span>
              <span style={{ marginLeft: "auto", fontWeight: "bold", color: scoreColor(j.bestScore ?? null), fontSize: 10 }}>
                {j.bestScore !== null ? `${j.bestScore}/50` : "—"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, color: "#666", fontSize: 10 }}>
              <span>{fmtDate(j.createdAt)}</span>
              <span>Gen {j.currentGeneration}/{j.maxGenerations}</span>
              <span style={{ color: j.status === "running" ? "#006600" : j.status === "error" ? "#880000" : "#000080" }}>
                {j.status}
              </span>
            </div>
          </div>
            );
          });
        })()
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function OptimizePage() {
  const [configs, setConfigs] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);

  // Job config form
  const [seedConfig, setSeedConfig] = useState("");
  const [maxGenerations, setMaxGenerations] = useState(10);
  const [variantsPerGen, setVariantsPerGen] = useState(6);
  const [maxTurns, setMaxTurns] = useState(30);
  const [temperature, setTemperature] = useState(0.85);
  const [judgeModel, setJudgeModel] = useState("huihui_ai/qwen3.5-abliterated:latest");
  const [mutationModel, setMutationModel] = useState("huihui_ai/qwen3.5-abliterated:latest");
  const [characterModel, setCharacterModel] = useState("huihui_ai/qwen3.5-abliterated:latest");

  // Active job state
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<OptimizationJob | null>(null);
  const [statusLine, setStatusLine] = useState("Ready.");
  const [population, setPopulation] = useState<RatedConfig[]>([]);

  // Live feed
  const [liveTurns, setLiveTurns] = useState<ConversationTurn[]>([]);
  const [liveVariantInfo, setLiveVariantInfo] = useState("");

  // Drill-down navigation
  const [drillJobId, setDrillJobId] = useState<string | null>(null);
  const [drillJobDetail, setDrillJobDetail] = useState<{ job: OptimizationJob; generations: GenerationRecord[] } | null>(null);
  const [drillGenIndex, setDrillGenIndex] = useState<number | null>(null);
  const [jobSortMode, setJobSortMode] = useState<"recent" | "score">("recent");

  // Transcript dialog
  const [viewingVariant, setViewingVariant] = useState<RatedConfig | null>(null);

  const feedRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  // ── data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/prompts")
      .then((r) => r.json())
      .then((d) => setConfigs((d.configs ?? []).map((c: { name: string }) => c.name)))
      .catch(() => {});

    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        const names = (d.models ?? []).map((m: { name: string }) => m.name);
        setModels(names);
        if (names.length > 0 && !judgeModel) setJudgeModel(names[0]);
      })
      .catch(() => {});

    loadJobs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function loadJobs() {
    fetch("/api/optimize/jobs")
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {});
  }

  function loadDrillDetail(jobId: string) {
    fetch(`/api/optimize/jobs/${jobId}`)
      .then((r) => r.json())
      .then((d) => setDrillJobDetail({ job: d.job, generations: d.generations ?? [] }))
      .catch(() => {});
  }

  // ── SSE subscription ────────────────────────────────────────────────────────

  const subscribeSSE = useCallback((jobId: string) => {
    sseRef.current?.close();
    const es = new EventSource(`/api/optimize/stream?jobId=${jobId}`);
    sseRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as OptimizationEvent;
        handleEvent(event);
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      setTimeout(() => {
        if (activeJobId === jobId && jobStatus?.status === "running") subscribeSSE(jobId);
      }, 3000);
    };
  }, [activeJobId, jobStatus?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleEvent(event: OptimizationEvent) {
    switch (event.type) {
      case "turn_complete":
        if (event.turn) {
          setLiveTurns((prev) => [...prev, event.turn!]);
          setTimeout(() => {
            if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
          }, 50);
        }
        break;

      case "mutation_complete":
        setLiveVariantInfo(
          `Gen ${event.generation} — Variant ${(event.variant ?? 0) + 1} — Mutation: ${event.mutationField ?? "seed"}`,
        );
        setLiveTurns([]);
        break;

      case "run_complete":
        setStatusLine(
          `Gen ${event.generation} Var ${(event.variant ?? 0) + 1}: run done (${event.turnCount} turns). Rating...`,
        );
        break;

      case "rating_complete":
        setStatusLine(
          `Gen ${event.generation} Var ${(event.variant ?? 0) + 1}: rated ${event.rating?.total ?? "null"}/50`,
        );
        fetch(`/api/optimize/status?jobId=${event.jobId}`)
          .then((r) => r.json())
          .then((job: OptimizationJob) => {
            setPopulation(job.population ?? []);
            setJobStatus(job);
          })
          .catch(() => {});
        loadDrillDetail(event.jobId);
        break;

      case "generation_complete":
        setStatusLine(`Generation ${event.generation} complete. Elite score: ${event.elite?.total ?? "?"}/50`);
        loadJobs();
        if (activeJobId) loadDrillDetail(activeJobId);
        break;

      case "job_complete":
        setStatusLine("Job complete.");
        setJobStatus((prev) => (prev ? { ...prev, status: "complete" } : prev));
        loadJobs();
        if (activeJobId) loadDrillDetail(activeJobId);
        break;

      case "error":
        setStatusLine(`Error: ${event.message ?? "unknown"}`);
        setJobStatus((prev) => (prev ? { ...prev, status: "error" } : prev));
        loadJobs();
        break;
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────────

  async function handleStart() {
    if (!seedConfig) return;
    setStatusLine("Starting job...");
    setLiveTurns([]);
    setPopulation([]);

    const res = await fetch("/api/optimize/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seedConfigName: seedConfig,
        maxGenerations,
        variantsPerGeneration: variantsPerGen,
        maxTurnsPerRun: maxTurns,
        temperature,
        judgeModel,
        mutationModel,
        characterModel,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatusLine(`Error: ${(err as { error?: string }).error ?? "Failed to start"}`);
      return;
    }

    const { jobId } = await res.json();
    setActiveJobId(jobId);
    setJobStatus({ id: jobId, status: "running" } as OptimizationJob);
    setDrillJobId(jobId);
    setDrillJobDetail(null);
    setDrillGenIndex(null);
    setStatusLine(`Job ${jobId} started. Running generation 1...`);
    subscribeSSE(jobId);
    loadJobs();
    loadDrillDetail(jobId);
  }

  async function handleStop() {
    if (!activeJobId) return;
    await fetch("/api/optimize/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId }),
    });
    setStatusLine("Stop requested...");
    // Optimistically update UI so the job stops showing as "running" immediately
    setJobStatus((prev) => (prev ? { ...prev, status: "stopped" } : prev));
    setJobs((prev) => prev.map((j) => j.id === activeJobId ? { ...j, status: "stopped" } : j));
  }

  function handleViewJob(jobId: string) {
    setActiveJobId(jobId);
    setDrillJobId(jobId);
    setDrillJobDetail(null);
    setDrillGenIndex(null);
    setLiveTurns([]);

    fetch(`/api/optimize/status?jobId=${jobId}`)
      .then((r) => r.json())
      .then((job: OptimizationJob) => {
        setJobStatus(job);
        setPopulation(job.population ?? []);
        setStatusLine(`Job ${jobId}: ${job.status}`);
      })
      .catch(() => {});

    loadDrillDetail(jobId);
    subscribeSSE(jobId);
  }

  const isRunning = jobStatus?.status === "running";

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: "#c0c0c0" }}
      className="w95-raise"
    >
      {/* Title Bar */}
      <div className="w95-titlebar">
        <a href="/" style={{ textDecoration: "none" }}>
          <button className="w95-winbtn" title="Back to Arena">←</button>
        </a>
        <span style={{ marginLeft: 4 }}>Agent Arena — Evolve</span>
        <div className="w95-winctrls">
          <button className="w95-winbtn">_</button>
          <button className="w95-winbtn">□</button>
          <button className="w95-winbtn">✕</button>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* LEFT PANEL — controls + hierarchical browser */}
        <div style={{ width: 420, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "2px solid #808080", overflow: "hidden" }}>

          {/* Job control form */}
          <div style={{ padding: "6px 8px", borderBottom: "1px solid #808080", background: "#c0c0c0" }}>
            <div style={{ fontWeight: "bold", fontSize: 11, marginBottom: 4, color: "#000080" }}>
              Evolution Circuit
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 10px", fontSize: 11 }}>
              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Seed Config</label>
                <select
                  className="w95-select"
                  value={seedConfig}
                  onChange={(e) => setSeedConfig(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="">— select —</option>
                  {configs.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Max Generations</label>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <W95Slider min={1} max={100} step={1} value={maxGenerations} onChange={setMaxGenerations} />
                  <span className="w95-trackbar-value">{maxGenerations}</span>
                </div>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Variants / Gen</label>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <W95Slider min={2} max={10} step={1} value={variantsPerGen} onChange={setVariantsPerGen} />
                  <span className="w95-trackbar-value">{variantsPerGen}</span>
                </div>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Max Turns / Run</label>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <W95Slider min={5} max={100} step={5} value={maxTurns} onChange={setMaxTurns} />
                  <span className="w95-trackbar-value">{maxTurns}</span>
                </div>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Temperature</label>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <W95Slider min={0} max={2} step={0.05} value={temperature} onChange={setTemperature} />
                  <span className="w95-trackbar-value">{temperature.toFixed(2)}</span>
                </div>
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", marginBottom: 1 }}>Evolution Model <span style={{ fontSize: 9, color: "#666" }}>(rates + mutates)</span></label>
                <select
                  className="w95-select"
                  value={judgeModel}
                  onChange={(e) => { setJudgeModel(e.target.value); setMutationModel(e.target.value); }}
                  style={{ width: "100%" }}
                >
                  <option key={judgeModel} value={judgeModel}>{judgeModel}</option>
                  {models.filter((m) => m !== judgeModel).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", marginBottom: 1 }}>Character Model <span style={{ fontSize: 9, color: "#666" }}>(roleplay agents)</span></label>
                <select
                  className="w95-select"
                  value={characterModel}
                  onChange={(e) => setCharacterModel(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value={characterModel}>{characterModel}</option>
                  {models.filter((m) => m !== characterModel).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
              <button
                className="w95-btn w95-btn-primary"
                onClick={handleStart}
                disabled={!seedConfig || isRunning}
              >
                Start Job
              </button>
              <button
                className="w95-btn"
                onClick={handleStop}
                disabled={!activeJobId || !isRunning}
              >
                Stop
              </button>
              {activeJobId && (
                <span style={{ fontSize: 10, color: "#666", alignSelf: "center" }}>
                  Job: {activeJobId}
                </span>
              )}
            </div>
          </div>

          {/* Hierarchical browser: Runs → Generations → Variants */}
          <div className="w95-scrollable" style={{ flex: 1, overflowY: "auto", background: "#ffffff" }}>
            {drillGenIndex !== null && drillJobDetail?.generations[drillGenIndex] ? (
              <VariantsView
                gen={drillJobDetail.generations[drillGenIndex]}
                onBack={() => setDrillGenIndex(null)}
                onViewTranscript={setViewingVariant}
              />
            ) : drillJobId !== null ? (
              <GenerationsView
                jobDetail={drillJobDetail}
                jobRunLabel={(() => {
                  if (!drillJobDetail) return "Loading...";
                  const name = drillJobDetail.job.seedConfigName;
                  const siblings = [...jobs]
                    .filter((j) => j.seedConfigName === name)
                    .sort((a, b) => a.createdAt > b.createdAt ? 1 : -1)
                    .map((j) => j.id);
                  const num = siblings.length > 1 ? ` #${siblings.indexOf(drillJobId) + 1}` : "";
                  return `${name}${num}`;
                })()}
                onBack={() => { setDrillJobId(null); setDrillJobDetail(null); setDrillGenIndex(null); }}
                onSelectGen={(idx) => setDrillGenIndex(idx)}
              />
            ) : (
              <JobsView
                jobs={jobs}
                activeJobId={activeJobId}
                sortMode={jobSortMode}
                onSortChange={setJobSortMode}
                onSelectJob={handleViewJob}
              />
            )}
          </div>
        </div>

        {/* RIGHT PANEL — live feed */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            className="aol-panel-header"
            style={{ padding: "3px 8px", fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ fontWeight: "bold" }}>Live Simulation Feed</span>
            {liveVariantInfo && (
              <span style={{ opacity: 0.85 }}>— {liveVariantInfo}</span>
            )}
          </div>

          <div
            ref={feedRef}
            className="aol-chat w95-deep-inset w95-scrollable"
            style={{ flex: 1, overflowY: "auto" }}
          >
            {liveTurns.length === 0 ? (
              <div className="aol-msg aol-msg-system">
                {activeJobId ? "Waiting for first turn..." : "Start a job to see live dialogue here."}
              </div>
            ) : (
              liveTurns.map((turn, i) => {
                const colorIdx = turn.agentIndex % AGENT_COLORS.length;
                return (
                  <div key={i} className="aol-msg" style={{ background: AGENT_BG[colorIdx] }}>
                    <span style={{ color: AGENT_COLORS[colorIdx], fontWeight: "bold", fontSize: 11 }}>
                      {turn.agentName}:{" "}
                    </span>
                    <span style={{ fontSize: 12 }}>{turn.content}</span>
                  </div>
                );
              })
            )}
          </div>

        </div>
      </div>

      {viewingVariant && (
        <TranscriptDialog variant={viewingVariant} onClose={() => setViewingVariant(null)} />
      )}
    </div>
  );
}
