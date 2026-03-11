"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ConversationTurn,
  OptimizationJob,
  OptimizationEvent,
  RatedConfig,
  RatingResult,
  JobSummary,
} from "@/lib/types";

const AGENT_COLORS = ["#000099", "#990000", "#555555", "#006600", "#880088"];
const AGENT_BG = ["#f0f4ff", "#fff2f2", "#e8e8e8", "#f0fff0", "#f8f0ff"];

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── transcript dialog ────────────────────────────────────────────────────────

function TranscriptDialog({
  variant,
  onClose,
}: {
  variant: RatedConfig;
  onClose: () => void;
}) {
  const names = (variant.config.characters ?? []).map((c) => c.name);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
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

        {/* Rating summary */}
        {variant.rating && (
          <div style={{ padding: "6px 8px", background: "#f0f0f0", borderBottom: "1px solid #808080", fontSize: 11 }}>
            <div style={{ fontWeight: "bold", marginBottom: 3, color: scoreColor(variant.rating.total) }}>
              Score: {variant.rating.total}/50 — {variant.rating.summary}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "2px 8px" }}>
              {(["emotionalAuthenticity", "naturalDialogue", "dramaticTensionArc", "scenarioCoherence", "organicResolution"] as const).map((k) => (
                <div key={k}>
                  <div style={{ fontSize: 10, color: "#666" }}>
                    {k.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase())}
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

        {/* Transcript */}
        <div className="aol-chat w95-deep-inset w95-scrollable" style={{ flex: 1, overflowY: "auto" }}>
          {variant.turns.filter((t) => !t.isStreaming && t.content.trim()).map((turn, i) => {
            const nameIdx = names.indexOf(turn.agentName);
            const colorIdx = nameIdx >= 0 ? nameIdx : turn.agentIndex;
            const bg = AGENT_BG[colorIdx % AGENT_BG.length];
            const color = AGENT_COLORS[colorIdx % AGENT_COLORS.length];
            return (
              <div key={i} className="aol-msg" style={{ background: bg }}>
                <span style={{ color, fontWeight: "bold", fontSize: 11 }}>{turn.agentName}: </span>
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

// ── leaderboard ──────────────────────────────────────────────────────────────

function Leaderboard({
  population,
  onViewTranscript,
}: {
  population: RatedConfig[];
  onViewTranscript: (v: RatedConfig) => void;
}) {
  if (population.length === 0) {
    return (
      <div style={{ padding: "6px 8px", fontSize: 11, color: "#808080", fontStyle: "italic" }}>
        No results yet. Start a job to populate the leaderboard.
      </div>
    );
  }

  const sorted = [...population].sort((a, b) => (b.rating?.total ?? -1) - (a.rating?.total ?? -1));

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
        <thead>
          <tr style={{ background: "#000080", color: "#ffffff" }}>
            <th style={{ padding: "2px 4px", textAlign: "left" }}>#</th>
            <th style={{ padding: "2px 4px", textAlign: "left" }}>Config</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Gen</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Score</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Auth</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Dial</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Arc</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Coh</th>
            <th style={{ padding: "2px 4px", textAlign: "center" }}>Res</th>
            <th style={{ padding: "2px 4px", textAlign: "left" }}>Mut</th>
            <th style={{ padding: "2px 4px" }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v, i) => {
            const r = v.rating;
            const bg = i % 2 === 0 ? "#ffffff" : "#f0f0f0";
            return (
              <tr key={i} style={{ background: bg }}>
                <td style={{ padding: "2px 4px", color: "#808080" }}>{i + 1}</td>
                <td style={{ padding: "2px 4px", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.config.name}
                </td>
                <td style={{ padding: "2px 4px", textAlign: "center" }}>{v.generationIndex}</td>
                <td style={{ padding: "2px 4px", textAlign: "center", fontWeight: "bold", color: scoreColor(r?.total ?? null) }}>
                  {r ? r.total : "—"}
                </td>
                <td style={{ padding: "2px 4px", textAlign: "center" }}>{r?.emotionalAuthenticity.score ?? "—"}</td>
                <td style={{ padding: "2px 4px", textAlign: "center" }}>{r?.naturalDialogue.score ?? "—"}</td>
                <td style={{ padding: "2px 4px", textAlign: "center" }}>{r?.dramaticTensionArc.score ?? "—"}</td>
                <td style={{ padding: "2px 4px", textAlign: "center" }}>{r?.scenarioCoherence.score ?? "—"}</td>
                <td style={{ padding: "2px 4px", textAlign: "center" }}>{r?.organicResolution.score ?? "—"}</td>
                <td style={{ padding: "2px 4px", color: "#666", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {v.mutationField}
                </td>
                <td style={{ padding: "2px 4px" }}>
                  <button
                    className="w95-btn"
                    style={{ fontSize: 10, minWidth: "unset", padding: "1px 6px" }}
                    onClick={() => onViewTranscript(v)}
                  >
                    View
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── main page ────────────────────────────────────────────────────────────────

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

  // Active job state
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<OptimizationJob | null>(null);
  const [statusLine, setStatusLine] = useState("Ready.");
  const [population, setPopulation] = useState<RatedConfig[]>([]);

  // Live feed
  const [liveTurns, setLiveTurns] = useState<ConversationTurn[]>([]);
  const [liveVariantInfo, setLiveVariantInfo] = useState("");

  // UI state
  const [viewingVariant, setViewingVariant] = useState<RatedConfig | null>(null);
  const [activeJobTab, setActiveJobTab] = useState<"live" | "jobs">("live");

  const feedRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  // ── data loading ───────────────────────────────────────────

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

  // ── SSE subscription ───────────────────────────────────────

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
      // Reconnect after 3s
      setTimeout(() => {
        if (activeJobId === jobId) subscribeSSE(jobId);
      }, 3000);
    };
  }, [activeJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleEvent(event: OptimizationEvent) {
    switch (event.type) {
      case "turn_complete":
        if (event.turn) {
          setLiveTurns((prev) => [...prev, event.turn!]);
          setTimeout(() => {
            if (feedRef.current) {
              feedRef.current.scrollTop = feedRef.current.scrollHeight;
            }
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
        // Reload full status to get updated population
        if (activeJobId) {
          fetch(`/api/optimize/status?jobId=${activeJobId}`)
            .then((r) => r.json())
            .then((job: OptimizationJob) => {
              setPopulation(job.population ?? []);
              setJobStatus(job);
            })
            .catch(() => {});
        }
        break;

      case "generation_complete":
        setStatusLine(
          `Generation ${event.generation} complete. Elite score: ${event.elite?.total ?? "?"}/50`,
        );
        loadJobs();
        break;

      case "job_complete":
        setStatusLine("Job complete.");
        setJobStatus((prev) => prev ? { ...prev, status: "complete" } : prev);
        loadJobs();
        break;

      case "error":
        setStatusLine(`Error: ${event.message ?? "unknown"}`);
        setJobStatus((prev) => prev ? { ...prev, status: "error" } : prev);
        break;
    }
  }

  // ── actions ────────────────────────────────────────────────

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
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatusLine(`Error: ${(err as { error?: string }).error ?? "Failed to start"}`);
      return;
    }

    const { jobId } = await res.json();
    setActiveJobId(jobId);
    setActiveJobTab("live");
    setStatusLine(`Job ${jobId} started. Running generation 1...`);
    subscribeSSE(jobId);
    loadJobs();
  }

  async function handleStop() {
    if (!activeJobId) return;
    await fetch("/api/optimize/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId }),
    });
    setStatusLine("Stop requested...");
  }

  function handleViewJob(jobId: string) {
    setActiveJobId(jobId);
    setActiveJobTab("live");
    setLiveTurns([]);

    fetch(`/api/optimize/status?jobId=${jobId}`)
      .then((r) => r.json())
      .then((job: OptimizationJob) => {
        setJobStatus(job);
        setPopulation(job.population ?? []);
        setStatusLine(`Job ${jobId}: ${job.status}`);
      })
      .catch(() => {});

    subscribeSSE(jobId);
  }

  const isRunning = jobStatus?.status === "running";

  return (
    <div
      style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: "#c0c0c0" }}
      className="w95-raise"
    >
      {/* Title Bar */}
      <div className="w95-titlebar">
        <span>Agent Arena — Evolve</span>
        <div className="w95-winctrls">
          <a href="/" style={{ textDecoration: "none" }}>
            <button className="w95-winbtn" title="Back to Arena">←</button>
          </a>
          <button className="w95-winbtn">_</button>
          <button className="w95-winbtn">□</button>
          <button className="w95-winbtn">✕</button>
        </div>
      </div>

      {/* Menu bar */}
      <div className="w95-menubar">
        <span className="w95-menuitem">
          <a href="/" style={{ textDecoration: "none", color: "inherit" }}>← Back to Arena</a>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "#555", padding: "2px 6px" }}>
          Run → Rate → Select → Mutate → Loop
        </span>
      </div>

      {/* Main layout */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, gap: 0 }}>

        {/* LEFT PANEL — controls + leaderboard */}
        <div
          style={{
            width: 420,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: "2px solid #808080",
            overflow: "hidden",
          }}
        >
          {/* Job control */}
          <div style={{ padding: "6px 8px", borderBottom: "1px solid #808080", background: "#c0c0c0" }}>
            <div style={{ fontWeight: "bold", fontSize: 11, marginBottom: 4, color: "#000080" }}>
              Evolution Circuit
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", fontSize: 11 }}>
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
                <input
                  type="number"
                  className="w95-input"
                  value={maxGenerations}
                  onChange={(e) => setMaxGenerations(Number(e.target.value))}
                  min={1}
                  max={100}
                />
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Variants / Gen</label>
                <input
                  type="number"
                  className="w95-input"
                  value={variantsPerGen}
                  onChange={(e) => setVariantsPerGen(Number(e.target.value))}
                  min={2}
                  max={10}
                />
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Max Turns / Run</label>
                <input
                  type="number"
                  className="w95-input"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(Number(e.target.value))}
                  min={5}
                  max={100}
                />
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 1 }}>Temperature</label>
                <input
                  type="number"
                  className="w95-input"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  min={0}
                  max={2}
                  step={0.05}
                />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", marginBottom: 1 }}>Evolution Model (rates + mutates)</label>
                <select
                  className="w95-select"
                  value={judgeModel}
                  onChange={(e) => { setJudgeModel(e.target.value); setMutationModel(e.target.value); }}
                  style={{ width: "100%" }}
                >
                  <option value={judgeModel}>{judgeModel}</option>
                  {models.filter((m) => m !== judgeModel).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
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

          {/* Status */}
          <div className="w95-statusbar" style={{ padding: "3px 6px" }}>
            <div className="w95-status-pane" style={{ flex: 1 }}>
              {statusLine}
            </div>
            {jobStatus && (
              <div
                className="w95-status-pane"
                style={{
                  color:
                    jobStatus.status === "running"
                      ? "#006600"
                      : jobStatus.status === "error"
                      ? "#880000"
                      : "#000080",
                  fontWeight: "bold",
                }}
              >
                {jobStatus.status === "running"
                  ? `Gen ${jobStatus.currentGeneration}/${jobStatus.maxGenerations}`
                  : jobStatus.status}
              </div>
            )}
          </div>

          {/* Leaderboard tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid #808080", background: "#c0c0c0" }}>
            {(["live", "jobs"] as const).map((tab) => (
              <button
                key={tab}
                style={{
                  padding: "3px 12px",
                  fontSize: 11,
                  background: activeJobTab === tab ? "#ffffff" : "#c0c0c0",
                  border: "none",
                  borderRight: "1px solid #808080",
                  cursor: "pointer",
                  fontWeight: activeJobTab === tab ? "bold" : "normal",
                }}
                onClick={() => setActiveJobTab(tab)}
              >
                {tab === "live" ? "Leaderboard" : "Past Jobs"}
              </button>
            ))}
          </div>

          {/* Leaderboard / Jobs list */}
          <div className="w95-scrollable" style={{ flex: 1, overflowY: "auto", background: "#ffffff" }}>
            {activeJobTab === "live" ? (
              <Leaderboard population={population} onViewTranscript={setViewingVariant} />
            ) : (
              <div style={{ fontSize: 11 }}>
                {jobs.length === 0 ? (
                  <div style={{ padding: "8px", color: "#808080", fontStyle: "italic" }}>No past jobs.</div>
                ) : (
                  jobs.map((j) => (
                    <div
                      key={j.id}
                      style={{
                        padding: "4px 8px",
                        borderBottom: "1px solid #ddd",
                        cursor: "pointer",
                        background: j.id === activeJobId ? "#e0e8ff" : "transparent",
                      }}
                      onClick={() => handleViewJob(j.id)}
                    >
                      <div style={{ fontWeight: "bold" }}>{j.seedConfigName}</div>
                      <div style={{ color: "#666", fontSize: 10 }}>
                        {fmtDate(j.createdAt)} — Gen {j.currentGeneration}/{j.maxGenerations} —{" "}
                        <span
                          style={{
                            color:
                              j.status === "running"
                                ? "#006600"
                                : j.status === "error"
                                ? "#880000"
                                : "#000080",
                          }}
                        >
                          {j.status}
                        </span>
                        {j.bestScore !== null && ` — Best: ${j.bestScore}/50`}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANEL — live feed */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Live feed header */}
          <div
            className="aol-panel-header"
            style={{ padding: "3px 8px", fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ fontWeight: "bold" }}>Live Simulation Feed</span>
            {liveVariantInfo && (
              <span style={{ opacity: 0.85 }}>— {liveVariantInfo}</span>
            )}
          </div>

          {/* Feed */}
          <div
            ref={feedRef}
            className="aol-chat w95-deep-inset w95-scrollable"
            style={{ flex: 1, overflowY: "auto" }}
          >
            {liveTurns.length === 0 ? (
              <div className="aol-msg aol-msg-system">
                {activeJobId
                  ? "Waiting for first turn..."
                  : "Start a job to see live dialogue here."}
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

          {/* Status bar */}
          <div className="w95-statusbar">
            <div className="w95-status-pane" style={{ flex: 1 }}>
              {activeJobId ? `Job ID: ${activeJobId}` : "No active job"}
            </div>
            <div className="w95-status-pane">
              Population: {population.length}
            </div>
            {population.length > 0 && (
              <div className="w95-status-pane" style={{ color: scoreColor(population[0].rating?.total ?? null) }}>
                Best: {population[0].rating?.total ?? "—"}/50
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transcript dialog */}
      {viewingVariant && (
        <TranscriptDialog variant={viewingVariant} onClose={() => setViewingVariant(null)} />
      )}
    </div>
  );
}
