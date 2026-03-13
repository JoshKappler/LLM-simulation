"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { MafiaPlayer, MafiaMessage, MafiaVote, MafiaRole, MafiaRunRecord } from "@/lib/mafia/types";
import { PRESET_PERSONALITIES, pickColor, pickRandomNames, pickRandomPersonalities } from "@/lib/mafia/pools";
import { streamChatResponse } from "@/lib/streamChat";
import { cleanOutput } from "@/lib/cleanOutput";
import type { ChatRequest } from "@/lib/types";
import { W95Slider } from "@/components/W95Slider";
import { fmtDate } from "@/lib/formatDate";
import { MESSAGE_WINDOW, VOTE_CONTEXT_WINDOW, DEFAULT_TEMPERATURE, MODEL_KEY, TEMP_KEY } from "@/lib/mafia/constants";
import type { DoctorProtection, RoundHistoryEntry } from "@/lib/mafia/prompts";
import {
  buildDayPrompt, buildRebuttalPrompt, buildFollowUpPrompt, buildVotePrompt,
  buildTrialDefensePrompt, buildJudgmentVotePrompt, buildWolfDiscussionPrompt,
  buildDoctorPrompt, buildDetectivePrompt, buildLastWordsPrompt,
  buildDeathReactionPrompt, buildWolfStrategyPrompt, buildInterjectionPrompt,
  buildGeneratorPrompt,
} from "@/lib/mafia/prompts";
import {
  nextMsgId, shuffle, checkWinCondition, detectEchoChamber,
  formatTrialContext, formatRecentChat, formatWolfContext,
  parseVotesFromSpeech, parseWolfKillFromDiscussion, parseNightChoiceWithRetry,
  parseJudgmentVotes, orchestrateAccusations,
} from "@/lib/mafia/helpers";

// ── Dialog component ──────────────────────────────────────────────────────────

function Dialog({ title, onClose, children, width }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  return (
    <div className="w95-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w95-dialog" style={{ width: width ?? 600 }}>
        <div className="w95-titlebar">
          <span>{title}</span>
          <div className="w95-winctrls">
            <button className="w95-winbtn" onClick={onClose}>✕</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Transcript Viewer Modal ───────────────────────────────────────────────────

function TranscriptModal({ run, onClose, onBack }: {
  run: MafiaRunRecord; onClose: () => void; onBack: () => void;
}) {
  const [viewTab, setViewTab] = useState<"transcript" | "players">("transcript");
  const [expandedMsgs, setExpandedMsgs] = useState<Set<number>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  const winLabel = run.winner === "villagers"
    ? "Villagers won" : run.winner === "wolves" ? "Wolves won" : "Unfinished";

  function roleLabel(role: MafiaRole): string {
    if (role === "wolf") return "WOLF";
    if (role === "doctor") return "DOCTOR";
    if (role === "detective") return "DETECTIVE";
    return "VILLAGER";
  }

  function roleColor(role: MafiaRole): string {
    if (role === "wolf") return "#cc0000";
    if (role === "doctor") return "#0066aa";
    if (role === "detective") return "#886600";
    return "#006600";
  }

  return (
    <Dialog
      title={`Game — ${fmtDate(run.savedAt)} — ${winLabel}`}
      onClose={onClose}
      width={660}
    >
      <div style={{ display: "flex", borderBottom: "2px solid #808080", background: "#d4d0c8", padding: "4px 8px 0" }}>
        <button
          className="w95-btn"
          style={{ fontSize: 10, marginRight: 8, minWidth: 50, padding: "2px 6px" }}
          onClick={onBack}
        >
          &larr; Back
        </button>
        {(["transcript", "players"] as const).map((t) => (
          <button
            key={t}
            className={`w95-tab ${viewTab === t ? "w95-tab-active" : "w95-tab-inactive"}`}
            style={{ padding: "2px 10px", fontSize: 10 }}
            onClick={() => setViewTab(t)}
          >
            {t === "transcript" ? `Transcript (${run.messages.length})` : `Players (${run.players.length})`}
          </button>
        ))}
      </div>

      {viewTab === "transcript" && (
        <div className="aol-chat w95-scrollable" style={{ height: "60vh", flex: "none" }}>
          {run.messages.map((msg, i) => {
            if (msg.phase === "system") {
              const c = msg.content;
              const cls = c.startsWith("GAME OVER") ? "aol-msg-narrator"
                : c.startsWith("--- DAY") ? "aol-msg-dayheader"
                : c.startsWith("--- NIGHT") ? "aol-msg-nightheader"
                : c.startsWith("--- VOTE") ? "aol-msg-voteheader"
                : c.startsWith("☠") ? "aol-msg-death-kill"
                : c.startsWith("⚖") ? "aol-msg-death-hang"
                : c.startsWith("✚") ? "aol-msg-death-saved"
                : "aol-msg-system";
              return (
                <div key={i} className={`aol-msg ${cls}`}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "vote") {
              const player = run.players.find((p) => p.id === msg.playerId);
              return (
                <div key={i} className="aol-msg aol-msg-vote">
                  {player && <span className="aol-name" style={{ color: player.color }}>{msg.playerName}: </span>}
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "wolf-chat" || msg.phase === "wolf-strategy") {
              const player = run.players.find((p) => p.id === msg.playerId);
              return (
                <div key={i}>
                  <div
                    className="aol-msg aol-msg-wolf"
                    style={{ cursor: msg.systemPrompt ? "pointer" : undefined }}
                    onClick={() => {
                      if (!msg.systemPrompt) return;
                      setExpandedMsgs((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      });
                    }}
                  >
                    <span className="aol-name" style={{ color: player?.color }}>{msg.playerName}: </span>
                    {msg.content}
                    {msg.systemPrompt && (
                      <span style={{ fontSize: 8, color: "#884444", marginLeft: 4 }}>
                        {expandedMsgs.has(i) ? "▼" : "▶"}
                      </span>
                    )}
                  </div>
                  {expandedMsgs.has(i) && msg.systemPrompt && (
                    <pre style={{
                      fontSize: 8, background: "#fffff0", border: "1px solid #c0c0c0",
                      padding: "4px 6px", margin: "0 8px 4px", whiteSpace: "pre-wrap",
                      lineHeight: 1.3, color: "#444", maxHeight: 200, overflowY: "auto",
                    }}>{msg.systemPrompt}</pre>
                  )}
                </div>
              );
            }
            if (msg.phase === "reaction") {
              const player = run.players.find((p) => p.id === msg.playerId);
              const color = player?.color ?? "#000000";
              return (
                <div key={i} className="aol-msg" style={{ background: "#f0f0f0", borderLeft: "3px solid #666666", fontStyle: "italic" }}>
                  <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "doctor") {
              return (
                <div key={i} className="aol-msg" style={{ background: "#e8f4ff", fontStyle: "italic", fontSize: 10, color: "#0066aa" }}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "detective") {
              return (
                <div key={i} className="aol-msg" style={{ background: "#fff8e0", fontStyle: "italic", fontSize: 10, color: "#886600" }}>
                  {msg.content}
                </div>
              );
            }
            // Day speech
            const player = run.players.find((p) => p.id === msg.playerId);
            const color = player?.color ?? "#000000";
            return (
              <div key={i}>
                <div
                  className="aol-msg"
                  style={{
                    background: "#f8f8f8",
                    cursor: msg.systemPrompt ? "pointer" : undefined,
                  }}
                  onClick={() => {
                    if (!msg.systemPrompt) return;
                    setExpandedMsgs((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  }}
                >
                  <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                  {msg.content}
                  {msg.systemPrompt && (
                    <span style={{ fontSize: 8, color: "#808080", marginLeft: 4 }}>
                      {expandedMsgs.has(i) ? "▼" : "▶"}
                    </span>
                  )}
                </div>
                {expandedMsgs.has(i) && msg.systemPrompt && (
                  <pre style={{
                    fontSize: 8, background: "#fffff0", border: "1px solid #c0c0c0",
                    padding: "4px 6px", margin: "0 8px 4px", whiteSpace: "pre-wrap",
                    lineHeight: 1.3, color: "#444", maxHeight: 200, overflowY: "auto",
                  }}>{msg.systemPrompt}</pre>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {viewTab === "players" && (
        <div className="w95-scrollable" style={{ height: "60vh", padding: 8, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 16, fontSize: 9, color: "#555", marginBottom: 8 }}>
            <span>Model: <strong>{run.model}</strong></span>
            <span>Temp: <strong>{run.temperature}</strong></span>
            <span>Rounds: <strong>{run.roundCount}</strong></span>
          </div>
          {run.players.map((p) => (
            <div key={p.id} style={{
              padding: "6px 8px", marginBottom: 4,
              background: p.alive ? "#ffffff" : "#f0f0f0",
              border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              opacity: p.alive ? 1 : 0.6,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: p.color, fontWeight: "bold", fontSize: 12 }}>{p.name}</span>
                <span style={{
                  fontSize: 9, fontWeight: "bold", padding: "1px 4px",
                  background: p.role === "wolf" ? "#ffdddd" : p.role === "doctor" ? "#ddeeff" : p.role === "detective" ? "#fff8dd" : "#ddffdd",
                  color: roleColor(p.role),
                  border: "1px solid",
                  borderColor: roleColor(p.role),
                }}>
                  {roleLabel(p.role)}
                </span>
                {!p.alive && <span style={{ fontSize: 9, color: "#999" }}>(dead)</span>}
              </div>
              <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{p.personality}</div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ── Prompt Viewer Modal ───────────────────────────────────────────────────────

function PromptViewerModal({ players, round, onClose }: {
  players: MafiaPlayer[]; round: number; onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(players.find((p) => p.alive)?.id ?? null);
  const selected = players.find((p) => p.id === selectedId);

  const prompt = selected ? buildDayPrompt(selected, players, round) : "";

  function roleBadge(role: MafiaRole): string {
    if (role === "wolf") return "W";
    if (role === "doctor") return "Dr";
    if (role === "detective") return "Det";
    return "V";
  }

  function roleBadgeColor(role: MafiaRole): string {
    if (role === "wolf") return "#cc0000";
    if (role === "doctor") return "#0066aa";
    if (role === "detective") return "#886600";
    return "#006600";
  }

  return (
    <Dialog title="Player Prompts" onClose={onClose} width={700}>
      <div style={{ display: "flex", height: "60vh" }}>
        <div style={{
          width: 160, borderRight: "2px solid #808080", overflowY: "auto",
          background: "#ffffff",
        }}>
          {players.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              style={{
                padding: "4px 8px", cursor: "pointer", fontSize: 11,
                background: selectedId === p.id ? "#000080" : "transparent",
                color: selectedId === p.id ? "#ffffff" : p.alive ? "#000" : "#999",
                textDecoration: p.alive ? "none" : "line-through",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <span style={{ color: selectedId === p.id ? "#ffffff" : p.color, fontSize: 9 }}>●</span>
              {p.name}
              <span style={{
                fontSize: 8, marginLeft: "auto", fontWeight: "bold",
                color: selectedId === p.id ? "#ffffff" : roleBadgeColor(p.role),
              }}>
                {roleBadge(p.role)}
              </span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8, background: "#ffffff" }}>
          {selected ? (
            <>
              <div style={{ fontSize: 11, fontWeight: "bold", color: selected.color, marginBottom: 4 }}>
                {selected.name} — {selected.role.toUpperCase()}
                {!selected.alive && " (dead)"}
              </div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 8 }}>
                Personality: {selected.personality}
              </div>
              <div style={{ fontSize: 9, fontWeight: "bold", color: "#000080", marginBottom: 2 }}>
                SYSTEM PROMPT (Day {round})
              </div>
              <pre style={{
                fontSize: 9, background: "#fffff0", border: "2px solid",
                borderColor: "#808080 #ffffff #ffffff #808080",
                padding: "6px 8px", whiteSpace: "pre-wrap", lineHeight: 1.4,
                color: "#000", margin: 0,
              }}>{prompt}</pre>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "#808080", padding: 20 }}>Select a player</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ── Stats Modal ──────────────────────────────────────────────────────────────

function StatsModal({ games, onClose }: { games: MafiaRunRecord[]; onClose: () => void }) {
  const total = games.length;
  const wolfWins = games.filter((g) => g.winner === "wolves").length;
  const villagerWins = games.filter((g) => g.winner === "villagers").length;
  const unfinished = games.filter((g) => !g.winner).length;
  const avgRounds = total > 0
    ? (games.reduce((sum, g) => sum + g.roundCount, 0) / total).toFixed(1)
    : "—";

  const modelCounts = new Map<string, number>();
  for (const g of games) {
    modelCounts.set(g.model, (modelCounts.get(g.model) ?? 0) + 1);
  }
  const topModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  return (
    <Dialog title="Game Stats" onClose={onClose} width={340}>
      <div style={{ padding: 12, fontSize: 11 }}>
        {total === 0 ? (
          <div style={{ textAlign: "center", color: "#808080", padding: 20 }}>
            No saved games yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: "bold" }}>Total Games</span>
              <span>{total}</span>
            </div>
            <div style={{
              border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              background: "#ffffff", padding: 8,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#006600", fontWeight: "bold" }}>Villager Wins</span>
                <span>{villagerWins} ({total > 0 ? Math.round(villagerWins / total * 100) : 0}%)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#cc0000", fontWeight: "bold" }}>Wolf Wins</span>
                <span>{wolfWins} ({total > 0 ? Math.round(wolfWins / total * 100) : 0}%)</span>
              </div>
              {unfinished > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#808080" }}>Unfinished</span>
                  <span>{unfinished}</span>
                </div>
              )}
              {/* Win rate bar */}
              {(wolfWins + villagerWins) > 0 && (
                <div style={{
                  marginTop: 6, height: 12, display: "flex",
                  border: "1px solid #808080", overflow: "hidden",
                }}>
                  <div style={{
                    width: `${villagerWins / (wolfWins + villagerWins) * 100}%`,
                    background: "#006600",
                  }} />
                  <div style={{
                    width: `${wolfWins / (wolfWins + villagerWins) * 100}%`,
                    background: "#cc0000",
                  }} />
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: "bold" }}>Avg Rounds</span>
              <span>{avgRounds}</span>
            </div>
            {topModel && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: "bold" }}>Top Model</span>
                <span style={{ fontSize: 9 }}>{topModel[0]} ({topModel[1]})</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

export default function MafiaPage() {
  // ── state ──
  const [players, setPlayers] = useState<MafiaPlayer[]>([]);
  const [messages, setMessages] = useState<MafiaMessage[]>([]);
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<"setup" | "day" | "vote" | "night" | "ended">("setup");
  const [winner, setWinner] = useState<"villagers" | "wolves" | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);

  // Config
  const [playerCount, setPlayerCount] = useState(10);
  const [wolfCount, setWolfCount] = useState(2);
  const [maxRounds, setMaxRounds] = useState(8);
  const [temperature, setTemperature] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_TEMPERATURE;
    const stored = localStorage.getItem(TEMP_KEY);
    return stored ? parseFloat(stored) : DEFAULT_TEMPERATURE;
  });
  const [model, setModel] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(MODEL_KEY) ?? "";
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Personality customization
  const [usePresets, setUsePresets] = useState(true);
  const [customPersonalities, setCustomPersonalities] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Pre-game player editing
  const [previewPlayers, setPreviewPlayers] = useState<Array<{ name: string; personality: string }>>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editPersonality, setEditPersonality] = useState("");

  // Modals
  const [showPastGames, setShowPastGames] = useState(false);
  const [viewingRun, setViewingRun] = useState<MafiaRunRecord | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [pastGames, setPastGames] = useState<MafiaRunRecord[]>([]);

  // ── refs ──
  const stopFlagRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const playersRef = useRef<MafiaPlayer[]>([]);
  const messagesRef = useRef<MafiaMessage[]>([]);
  const roundRef = useRef(0);
  const modelRef = useRef("");
  const temperatureRef = useRef(DEFAULT_TEMPERATURE);
  const maxRoundsRef = useRef(8);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const winnerRef = useRef<"villagers" | "wolves" | null>(null);
  const lastProtectedRef = useRef<string | null>(null);
  const detectiveResultsRef = useRef<Array<{ round: number; target: string; isWolf: boolean }>>([]);
  const doctorHistoryRef = useRef<DoctorProtection[]>([]);
  const roundHistoryRef = useRef<RoundHistoryEntry[]>([]);
  const playerSaidRef = useRef<Map<string, string[]>>(new Map());

  // ── sync refs ──
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { roundRef.current = round; }, [round]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { temperatureRef.current = temperature; }, [temperature]);
  useEffect(() => { maxRoundsRef.current = maxRounds; }, [maxRounds]);
  useEffect(() => { winnerRef.current = winner; }, [winner]);


  // Clamp wolf count: wolves must be strictly fewer than non-wolves
  useEffect(() => {
    const maxW = Math.max(1, Math.floor((playerCount - 1) / 2));
    if (wolfCount > maxW) setWolfCount(maxW);
  }, [playerCount, wolfCount]);

  // ── auto-scroll ──
  useEffect(() => {
    if (isAtBottomRef.current) {
      chatContainerRef.current?.scrollTo({ top: chatContainerRef.current.scrollHeight });
    }
  }, [messages]);

  // ── fetch models ──
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models: string[] }) => {
        setAvailableModels(data.models ?? []);
        if (!model && data.models?.length) {
          setModel(data.models[0]);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── persist settings ──
  useEffect(() => { if (model) localStorage.setItem(MODEL_KEY, model); }, [model]);
  useEffect(() => { localStorage.setItem(TEMP_KEY, String(temperature)); }, [temperature]);

  // ── saved runs ──

  const loadPastGames = useCallback(() => {
    fetch("/api/mafia-runs")
      .then((r) => r.json())
      .then((data) => setPastGames(data.runs ?? []))
      .catch(() => setPastGames([]));
  }, []);

  const saveGame = useCallback((w: "villagers" | "wolves" | null) => {
    try {
      const record: MafiaRunRecord = {
        id: Date.now().toString(),
        savedAt: new Date().toISOString(),
        players: playersRef.current,
        messages: messagesRef.current,
        winner: w,
        roundCount: roundRef.current,
        model: modelRef.current,
        temperature: temperatureRef.current,
      };
      fetch("/api/mafia-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }).catch((err) => console.error("Failed to save game to disk:", err));
    } catch (err) {
      console.error("Failed to save game:", err);
    }
  }, []);

  const deleteGame = useCallback((id: string) => {
    fetch(`/api/mafia-runs/${id}`, { method: "DELETE" })
      .then(() => setPastGames((prev) => prev.filter((r) => r.id !== id)))
      .catch(() => {});
  }, []);

  // ── message helpers ──

  const addMessage = useCallback((msg: Omit<MafiaMessage, "id">) => {
    const full = { ...msg, id: nextMsgId() };
    setMessages((prev) => [...prev, full]);
    messagesRef.current = [...messagesRef.current, full];
    return full.id;
  }, []);

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
    messagesRef.current = messagesRef.current.map((m) => m.id === id ? { ...m, content } : m);
  }, []);

  // ── generate personalities via LLM ──

  const generatePersonalities = useCallback(async () => {
    if (!model) return;
    setIsGenerating(true);
    try {
      const existing = customPersonalities.concat(PRESET_PERSONALITIES.map((p) => p.personality));
      const prompt = buildGeneratorPrompt(playerCount, existing);
      const request: ChatRequest = {
        model,
        system: "You are a creative character designer. Reply with valid JSON only.",
        messages: [{ role: "user", content: prompt }],
        temperature: 1.0,
        numPredict: 2000,
      };
      let full = "";
      await streamChatResponse(request, (token) => { full += token; });

      const cleaned = full.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned) as Array<{ name: string; personality: string }>;
      setCustomPersonalities(parsed.map((p) => p.personality));
      setUsePresets(false);
    } catch (err) {
      console.error("Failed to generate personalities:", err);
    }
    setIsGenerating(false);
  }, [model, playerCount, customPersonalities]);

  // ── speech generation helper ──

  const generateSpeech = useCallback(async (
    systemPrompt: string,
    contextMsg: string,
    speaker: MafiaPlayer,
    currentRound: number,
    phaseType: MafiaMessage["phase"],
    temp?: number,
  ): Promise<string> => {
    const request: ChatRequest = {
      model: modelRef.current,
      system: systemPrompt,
      messages: [{ role: "user", content: contextMsg }],
      temperature: temp ?? temperatureRef.current,
    };

    const placeholderId = addMessage({
      round: currentRound,
      phase: phaseType,
      playerId: speaker.id,
      playerName: speaker.name,
      content: "",
      systemPrompt,
    });
    setStreamingMsgId(placeholderId);

    let streamedSoFar = "";
    let fullText = "";
    try {
      fullText = await streamChatResponse(request, (token) => {
        streamedSoFar += token;
        updateMessage(placeholderId, streamedSoFar);
      }, abortRef.current?.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        updateMessage(placeholderId, streamedSoFar || "(stopped)");
        setStreamingMsgId(null);
        return "";
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMessage(placeholderId, `[error: ${errMsg}]`);
      setStreamingMsgId(null);
      return "";
    }

    const allPlayerNames = playersRef.current.map((p) => p.name);
    let cleaned = cleanOutput(fullText, speaker.name, allPlayerNames);
    if (!cleaned.trim()) {
      cleaned = "(stays silent)";
    }

    updateMessage(placeholderId, cleaned);
    setStreamingMsgId(null);
    return cleaned;
  }, [addMessage, updateMessage]);

  // ── day phase: one player speaks ──

  const runDaySpeech = useCallback(async (speaker: MafiaPlayer, currentRound: number, notYetSpoken?: string[]) => {
    const detResults = speaker.role === "detective" ? detectiveResultsRef.current : undefined;
    const previousSaid = playerSaidRef.current.get(speaker.id);

    // Extract wolf strategy messages for this round so wolves can follow their plan
    let wolfStrategy: string[] | undefined;
    if (speaker.role === "wolf") {
      wolfStrategy = messagesRef.current
        .filter((m) => m.round === currentRound && m.phase === "wolf-strategy" && m.playerId)
        .map((m) => `${m.playerName}: ${m.content}`)
        .filter((s) => s.length > 0);
      if (wolfStrategy.length === 0) wolfStrategy = undefined;
    }

    const docHistory = speaker.role === "doctor" ? doctorHistoryRef.current : undefined;
    const echoWarning = detectEchoChamber(messagesRef.current, currentRound);
    const system = buildDayPrompt(speaker, playersRef.current, currentRound, detResults, roundHistoryRef.current, previousSaid, wolfStrategy, docHistory, notYetSpoken, echoWarning);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    const speech = await generateSpeech(system, recentChat, speaker, currentRound, "day");
    // Track what this player said (for no-repeat)
    if (speech && speech !== "(stays silent)") {
      const existing = playerSaidRef.current.get(speaker.id) || [];
      existing.push(speech.slice(0, 60));
      playerSaidRef.current.set(speaker.id, existing);
    }
  }, [generateSpeech]);

  // ── rebuttal: accused player defends ──

  const runRebuttalSpeech = useCallback(async (
    speaker: MafiaPlayer,
    currentRound: number,
    accuserNames: string[],
  ) => {
    const detResults = speaker.role === "detective" ? detectiveResultsRef.current : undefined;
    const docHistory = speaker.role === "doctor" ? doctorHistoryRef.current : undefined;
    const system = buildRebuttalPrompt(speaker, playersRef.current, currentRound, accuserNames, detResults, docHistory);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    await generateSpeech(system, recentChat, speaker, currentRound, "day");
  }, [generateSpeech]);

  // ── follow-up: accuser responds to defense ──

  const runFollowUpSpeech = useCallback(async (
    speaker: MafiaPlayer,
    currentRound: number,
    defendingPlayerName: string,
  ) => {
    const detResults = speaker.role === "detective" ? detectiveResultsRef.current : undefined;
    const docHistory = speaker.role === "doctor" ? doctorHistoryRef.current : undefined;
    const system = buildFollowUpPrompt(speaker, playersRef.current, currentRound, defendingPlayerName, detResults, docHistory);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    await generateSpeech(system, recentChat, speaker, currentRound, "day");
  }, [generateSpeech]);

  // ── last words: hanged player's final speech ──

  const runLastWords = useCallback(async (speaker: MafiaPlayer, currentRound: number) => {
    const detResults = speaker.role === "detective" ? detectiveResultsRef.current : undefined;
    const docHistory = speaker.role === "doctor" ? doctorHistoryRef.current : undefined;
    const system = buildLastWordsPrompt(speaker, playersRef.current, detResults, docHistory);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
    await generateSpeech(system, recentChat, speaker, currentRound, "day");
  }, [generateSpeech]);

  // ── wolf discussion ──

  const runWolfChat = useCallback(async (wolf: MafiaPlayer, currentRound: number) => {
    const system = buildWolfDiscussionPrompt(wolf, playersRef.current, currentRound);
    const context = formatWolfContext(messagesRef.current, currentRound);
    await generateSpeech(system, context, wolf, currentRound, "wolf-chat", 0.8);
  }, [generateSpeech]);

  // ── vote phase (two-stage trial system) ──

  const runVotePhase = useCallback(async (currentRound: number): Promise<{ hanged: MafiaPlayer | null; votes: MafiaVote[] }> => {
    setPhase("vote");
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `--- VOTE ${currentRound} --- The town must decide who to put on trial.`,
    });

    // ── STAGE 1: Accusation vote — who goes on trial? ──

    const alive = playersRef.current.filter((p) => p.alive);
    const speakOrder = shuffle(alive);
    const voteSpeechTexts: Array<{ voterName: string; voterId: string; speech: string }> = [];

    // Freeze context ONCE so later voters can't see earlier voters' speeches
    const frozenVoteContext = formatRecentChat(messagesRef.current, VOTE_CONTEXT_WINDOW, false, playersRef.current);

    for (const voter of speakOrder) {
      if (stopFlagRef.current) return { hanged: null, votes: [] };

      setStatusMsg(`${voter.name} names their suspect...`);
      const detResults = voter.role === "detective" ? detectiveResultsRef.current : undefined;
      const docHistory = voter.role === "doctor" ? doctorHistoryRef.current : undefined;
      const system = buildVotePrompt(voter, playersRef.current, roundHistoryRef.current, currentRound, detResults, docHistory);
      let speech = await generateSpeech(system, frozenVoteContext, voter, currentRound, "vote");

      if (!speech || speech === "(stays silent)") {
        speech = await generateSpeech(
          `You are ${voter.name}. You MUST accuse someone. Name one living person and say why. 1 sentence. No reasoning, no thinking tags.`,
          frozenVoteContext, voter, currentRound, "vote",
        );
      }

      voteSpeechTexts.push({ voterName: voter.name, voterId: voter.id, speech });
    }

    if (stopFlagRef.current) return { hanged: null, votes: [] };

    const validSpeeches = voteSpeechTexts.filter((s) => s.speech && s.speech !== "(stays silent)");
    const candidates = alive.map((p) => p.name);

    if (validSpeeches.length === 0) {
      addMessage({ round: currentRound, phase: "system", playerName: "System", content: "No one spoke. No one is put on trial today." });
      return { hanged: null, votes: [] };
    }

    setStatusMsg("Counting accusations...");
    const votes = await parseVotesFromSpeech(validSpeeches, candidates, modelRef.current, abortRef.current?.signal);

    for (const v of votes) {
      const match = voteSpeechTexts.find((s) => s.voterName === v.voterName);
      if (match) v.voterId = match.voterId;
    }

    // Tally accusation votes
    const tally = new Map<string, string[]>();
    for (const v of votes) {
      const existing = tally.get(v.targetName) ?? [];
      existing.push(v.voterName);
      tally.set(v.targetName, existing);
    }

    if (tally.size > 0) {
      const tallyParts = [...tally.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, voters]) => `${name} (${voters.length}) — ${voters.join(", ")}`);
      const noVoters = alive.filter((p) => !votes.some((v) => v.voterId === p.id)).map((p) => p.name);
      let tallyMsg = `Accusation tally: ${tallyParts.join(" | ")}`;
      if (noVoters.length > 0) tallyMsg += ` | Abstained: ${noVoters.join(", ")}`;
      addMessage({ round: currentRound, phase: "system", playerName: "System", content: tallyMsg });
    }

    const voteCounts = new Map<string, number>();
    for (const v of votes) {
      voteCounts.set(v.targetName, (voteCounts.get(v.targetName) ?? 0) + 1);
    }

    const maxVotes = Math.max(...voteCounts.values(), 0);
    if (maxVotes === 0) {
      addMessage({ round: currentRound, phase: "system", playerName: "System", content: "No valid accusations. No one is put on trial today." });
      return { hanged: null, votes };
    }

    // Tiebreak: random among tied
    const tied = [...voteCounts.entries()].filter(([, c]) => c === maxVotes).map(([n]) => n);
    const accusedName = tied[Math.floor(Math.random() * tied.length)];
    const accused = playersRef.current.find((p) => p.name === accusedName && p.alive);

    if (!accused) return { hanged: null, votes };

    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `${accused.name} is put on trial! They will now make their defense.`,
    });

    // ── STAGE 2: Trial defense — accused makes their case ──

    if (!stopFlagRef.current) {
      setStatusMsg(`${accused.name} defends themselves at trial...`);
      const defDetResults = accused.role === "detective" ? detectiveResultsRef.current : undefined;
      const defDocHistory = accused.role === "doctor" ? doctorHistoryRef.current : undefined;
      const defenseSystem = buildTrialDefensePrompt(accused, playersRef.current, defDetResults, defDocHistory);
      const defenseContext = formatRecentChat(messagesRef.current, MESSAGE_WINDOW, false, playersRef.current);
      await generateSpeech(defenseSystem, defenseContext, accused, currentRound, "vote");
    }

    if (stopFlagRef.current) return { hanged: null, votes };

    // ── STAGE 3: Judgment vote — hang or spare? ──

    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `The village votes: HANG or SPARE ${accused.name}?`,
    });

    const jurors = alive.filter((p) => p.id !== accused.id);
    const judgmentOrder = shuffle(jurors);
    const judgmentSpeeches: Array<{ voterName: string; speech: string }> = [];

    // Freeze trial context ONCE so later jurors can't see earlier jurors' votes
    const frozenTrialContext = formatTrialContext(messagesRef.current, currentRound, accused.name);

    for (const juror of judgmentOrder) {
      if (stopFlagRef.current) return { hanged: null, votes };

      setStatusMsg(`${juror.name} votes on ${accused.name}'s fate...`);
      const jurorDetResults = juror.role === "detective" ? detectiveResultsRef.current : undefined;
      const system = buildJudgmentVotePrompt(juror, accused, playersRef.current, jurorDetResults);
      const speech = await generateSpeech(system, frozenTrialContext, juror, currentRound, "vote");
      judgmentSpeeches.push({ voterName: juror.name, speech });
    }

    if (stopFlagRef.current) return { hanged: null, votes };

    // Parse hang/spare votes
    setStatusMsg("Counting judgment votes...");
    const judgment = await parseJudgmentVotes(judgmentSpeeches, accused.name, modelRef.current, abortRef.current?.signal);

    const hangCount = judgment.hang.length;
    const spareCount = judgment.spare.length;
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `Judgment: HANG (${hangCount}) — ${judgment.hang.join(", ") || "none"} | SPARE (${spareCount}) — ${judgment.spare.join(", ") || "none"}`,
    });

    // Majority needed to hang
    if (hangCount <= spareCount) {
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: `The village spares ${accused.name}. No one hangs today.`,
      });
      return { hanged: null, votes };
    }

    // ── STAGE 4: Last words, then execution ──

    if (!stopFlagRef.current) {
      setStatusMsg(`${accused.name} speaks their last words...`);
      await runLastWords(accused, currentRound);
    }

    const roleReveal = accused.role === "wolf" ? "They were a WOLF!"
      : accused.role === "doctor" ? "They were the DOCTOR."
      : accused.role === "detective" ? "They were the DETECTIVE."
      : "They were a villager.";
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: `⚖ ${accused.name} is dragged to the gallows and hanged (${hangCount}-${spareCount}). ${roleReveal}`,
    });

    const updated = playersRef.current.map((p) =>
      p.id === accused.id ? { ...p, alive: false } : p
    );
    setPlayers(updated);
    playersRef.current = updated;

    return { hanged: accused, votes };
  }, [addMessage, generateSpeech, runLastWords]);

  // ── night phase ──

  const runNightPhase = useCallback(async (currentRound: number): Promise<{ victim: MafiaPlayer | null; saved: boolean }> => {
    setPhase("night");
    addMessage({
      round: currentRound,
      phase: "system",
      playerName: "System",
      content: "--- NIGHT --- The town sleeps. Wolves gather in the shadows...",
    });

    const wolves = playersRef.current.filter((p) => p.alive && p.role === "wolf");
    const targets = playersRef.current.filter((p) => p.alive && p.role !== "wolf");

    if (wolves.length === 0 || targets.length === 0) return { victim: null, saved: false };

    // Wolf discussion — always run (solo wolf thinks aloud, 2+ wolves confer)
    const discussRounds = 1;
    for (let discussRound = 0; discussRound < discussRounds; discussRound++) {
      for (const wolf of wolves) {
        if (stopFlagRef.current) return { victim: null, saved: false };
        setStatusMsg(`${wolf.name} is plotting...`);
        await runWolfChat(wolf, currentRound);
      }
    }

    if (stopFlagRef.current) return { victim: null, saved: false };

    // Parse kill target from wolf discussion
    const targetNames = targets.map((p) => p.name);
    const wolfChatMsgs = messagesRef.current
      .filter((m) => m.round === currentRound && m.phase === "wolf-chat" && m.playerId)
      .map((m) => ({ wolfName: m.playerName, speech: m.content }))
      .filter((m) => m.speech && m.speech !== "(stays silent)");

    setStatusMsg("Wolves choose their victim...");

    // If wolves stayed silent, pick a random target
    let wolfTargetName: string | null;
    if (wolfChatMsgs.length === 0) {
      wolfTargetName = targetNames[Math.floor(Math.random() * targetNames.length)];
    } else {
      wolfTargetName = await parseWolfKillFromDiscussion(wolfChatMsgs, targetNames, modelRef.current, abortRef.current?.signal);
    }

    // Fallback: if parser failed, pick random target (wolves always kill)
    if (!wolfTargetName) {
      wolfTargetName = targetNames[Math.floor(Math.random() * targetNames.length)];
    }

    if (stopFlagRef.current) return { victim: null, saved: false };

    // Doctor protection
    let protectedName: string | null = null;
    const doctor = playersRef.current.find((p) => p.alive && p.role === "doctor");
    if (doctor) {
      setStatusMsg(`${doctor.name} chooses who to protect...`);
      const doctorSystem = buildDoctorPrompt(doctor, playersRef.current, lastProtectedRef.current, roundHistoryRef.current);
      const doctorRequest: ChatRequest = {
        model: modelRef.current,
        system: doctorSystem,
        messages: [{ role: "user", content: formatRecentChat(messagesRef.current, MESSAGE_WINDOW) }],
        temperature: 0.3,
      };

      let doctorResponse = "";
      try {
        doctorResponse = await streamChatResponse(doctorRequest, () => {}, abortRef.current?.signal);
      } catch {
        doctorResponse = "";
      }

      const validTargets = playersRef.current
        .filter((p) => p.alive && p.name !== lastProtectedRef.current)
        .map((p) => p.name);

      const doctorChoice = await parseNightChoiceWithRetry(doctorResponse, validTargets, "protect", modelRef.current, abortRef.current?.signal);
      protectedName = doctorChoice.name;
      lastProtectedRef.current = protectedName;

      const methodNote = doctorChoice.method !== "parsed" ? ` (${doctorChoice.method})` : "";
      addMessage({
        round: currentRound,
        phase: "doctor",
        playerId: doctor.id,
        playerName: doctor.name,
        content: `The Doctor chose to protect ${protectedName} tonight.${methodNote}`,
      });
    }

    // Detective investigation
    const detective = playersRef.current.find((p) => p.alive && p.role === "detective");
    if (detective && !stopFlagRef.current) {
      setStatusMsg(`${detective.name} investigates...`);
      const detSystem = buildDetectivePrompt(detective, playersRef.current, detectiveResultsRef.current);
      const detRequest: ChatRequest = {
        model: modelRef.current,
        system: detSystem,
        messages: [{ role: "user", content: formatRecentChat(messagesRef.current, MESSAGE_WINDOW) }],
        temperature: 0.3,
      };

      let detResponse = "";
      try {
        detResponse = await streamChatResponse(detRequest, () => {}, abortRef.current?.signal);
      } catch {
        detResponse = "";
      }

      const detCandidates = playersRef.current
        .filter((p) => p.alive && p.id !== detective.id)
        .map((p) => p.name);

      const detChoice = await parseNightChoiceWithRetry(detResponse, detCandidates, "investigate", modelRef.current, abortRef.current?.signal);
      const investigatedName = detChoice.name;
      const investigatedPlayer = playersRef.current.find((p) => p.name === investigatedName);
      const isWolf = investigatedPlayer?.role === "wolf";
      detectiveResultsRef.current = [...detectiveResultsRef.current, { round: currentRound, target: investigatedName, isWolf }];

      const detMethodNote = detChoice.method !== "parsed" ? ` (${detChoice.method})` : "";
      addMessage({
        round: currentRound,
        phase: "detective",
        playerId: detective.id,
        playerName: detective.name,
        content: `The Detective investigated ${investigatedName} — ${isWolf ? "they ARE a wolf!" : "they are NOT a wolf."}${detMethodNote}`,
      });
    }

    if (stopFlagRef.current) return { victim: null, saved: false };

    // Resolve night kill
    const victim = playersRef.current.find((p) => p.name === wolfTargetName && p.alive);

    // Track doctor protection history
    if (protectedName) {
      const saved = victim ? protectedName === victim.name : false;
      doctorHistoryRef.current = [...doctorHistoryRef.current, { round: currentRound, target: protectedName, saved }];
    }

    if (victim) {
      if (protectedName === victim.name) {
        addMessage({
          round: currentRound,
          phase: "system",
          playerName: "System",
          content: `✚ Dawn breaks. The wolves targeted ${victim.name}, but the Doctor saved them! Everyone survived the night.`,
        });
        return { victim: null, saved: true };
      }

      const updated = playersRef.current.map((p) =>
        p.id === victim.id ? { ...p, alive: false } : p
      );
      setPlayers(updated);
      playersRef.current = updated;

      const roleReveal = victim.role === "doctor" ? "doctor"
        : victim.role === "detective" ? "detective"
        : victim.role;
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: `☠ Dawn breaks. ${victim.name} was found dead — murdered by the wolves. They were a ${roleReveal}.`,
      });
    }

    return { victim: victim ?? null, saved: false };
  }, [addMessage, runWolfChat]);

  // ── main game loop ──

  const runGame = useCallback(async () => {
    let currentRound = 1;
    roundRef.current = 1;
    setRound(1);
    let gameWinner: "villagers" | "wolves" | null = null;

    try {
    while (!stopFlagRef.current) {
      if (currentRound > maxRoundsRef.current) {
        addMessage({
          round: currentRound,
          phase: "system",
          playerName: "System",
          content: "Maximum rounds reached. The wolves have outlasted the village!",
        });
        gameWinner = "wolves";
        setWinner("wolves");
        break;
      }

      // ── DAY PHASE ──
      setPhase("day");
      const aliveNowForHeader = playersRef.current.filter((p) => p.alive);
      const aliveNames = aliveNowForHeader.map((p) => p.name).join(", ");
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: `--- DAY ${currentRound} ---\nAlive (${aliveNowForHeader.length}): ${aliveNames}`,
      });

      // ── MORNING DEATH REACTIONS (round 2+) ──
      if (currentRound > 1 && roundHistoryRef.current.length > 0) {
        const lastHistory = roundHistoryRef.current[roundHistoryRef.current.length - 1];
        const deathsToReactTo: Array<{ name: string; role: string; wasHanging: boolean }> = [];

        if (lastHistory.nightKillName && !lastHistory.nightKillSaved) {
          const victim = playersRef.current.find((p) => p.name === lastHistory.nightKillName);
          deathsToReactTo.push({ name: lastHistory.nightKillName, role: victim?.role || "villager", wasHanging: false });
        }
        if (lastHistory.hangedName && lastHistory.hangedRole) {
          deathsToReactTo.push({ name: lastHistory.hangedName, role: lastHistory.hangedRole, wasHanging: true });
        }

        if (deathsToReactTo.length > 0) {
          const aliveNow = playersRef.current.filter((p) => p.alive);
          const reactorCount = aliveNow.length <= 5 ? 1 : 2;
          const reactors = shuffle(aliveNow).slice(0, Math.min(reactorCount, aliveNow.length));
          const primaryDeath = deathsToReactTo[0]; // night kill is most dramatic

          for (const reactor of reactors) {
            if (stopFlagRef.current) break;
            setStatusMsg(`${reactor.name} reacts to ${primaryDeath.name}'s death...`);
            const system = buildDeathReactionPrompt(reactor, primaryDeath.name, primaryDeath.role, playersRef.current, primaryDeath.wasHanging);
            await generateSpeech(system, "(React to the news.)", reactor, currentRound, "reaction");
          }
        }
      }

      if (stopFlagRef.current) break;

      // ── WOLF PRE-DAY STRATEGY WHISPER (round 2+) ──
      if (currentRound > 1) {
        const wolves = playersRef.current.filter((p) => p.alive && p.role === "wolf");
        if (wolves.length > 0) {
          for (const wolf of wolves) {
            if (stopFlagRef.current) break;
            setStatusMsg(`${wolf.name} strategizes...`);
            const system = buildWolfStrategyPrompt(wolf, playersRef.current, currentRound, roundHistoryRef.current);
            const lastKill = roundHistoryRef.current.length > 0
              ? roundHistoryRef.current[roundHistoryRef.current.length - 1].nightKillName
              : null;
            const context = lastKill
              ? `Last night you killed ${lastKill}. Plan your day.`
              : "Plan your day strategy.";
            await generateSpeech(system, context, wolf, currentRound, "wolf-strategy", 0.8);
          }
        }
      }

      if (stopFlagRef.current) break;

      const alive = playersRef.current.filter((p) => p.alive);
      const speakOrder = shuffle(alive);

      // Everyone speaks once
      for (let i = 0; i < speakOrder.length; i++) {
        if (stopFlagRef.current) break;
        const speaker = speakOrder[i];
        const notYetSpoken = speakOrder.slice(i + 1).map((p) => p.name);
        setStatusMsg(`${speaker.name} is speaking...`);
        await runDaySpeech(speaker, currentRound, notYetSpoken);
        if (stopFlagRef.current) break;
      }

      if (stopFlagRef.current) break;

      // LLM-based accusation detection
      setStatusMsg("Analyzing accusations...");
      const accusations = await orchestrateAccusations(
        messagesRef.current,
        currentRound,
        playersRef.current.filter((p) => p.alive),
        modelRef.current,
        abortRef.current?.signal,
      );

      // Filter to high/medium severity
      const significant = accusations.filter((a) => a.severity === "high" || a.severity === "medium");

      if (significant.length > 0 && !stopFlagRef.current) {
        const top = significant[0];
        const topPlayer = playersRef.current.find((p) => p.name === top.accused && p.alive);

        if (topPlayer) {
          // Accused defends → main accuser responds (kept tight: 2 messages)
          setStatusMsg(`${topPlayer.name} defends themselves...`);
          await runRebuttalSpeech(topPlayer, currentRound, top.accusers);
          if (stopFlagRef.current) break;

          const mainAccuser = playersRef.current.find(
            (p) => p.name === top.accusers[0] && p.alive
          );
          if (mainAccuser && !stopFlagRef.current) {
            setStatusMsg(`${mainAccuser.name} responds...`);
            await runFollowUpSpeech(mainAccuser, currentRound, topPlayer.name);
            if (stopFlagRef.current) break;
          }
        }
      }

      if (stopFlagRef.current) break;

      // ── VOTE PHASE ──
      setStatusMsg("Voting...");
      const voteResult = await runVotePhase(currentRound);
      if (stopFlagRef.current) break;

      const winAfterVote = checkWinCondition(playersRef.current);
      if (winAfterVote) {
        gameWinner = winAfterVote;
        setWinner(winAfterVote);
        break;
      }

      // ── NIGHT PHASE ──
      setStatusMsg("Night falls...");
      const nightResult = await runNightPhase(currentRound);
      if (stopFlagRef.current) break;

      // ── RECORD ROUND HISTORY ──
      roundHistoryRef.current.push({
        round: currentRound,
        hangedName: voteResult.hanged?.name ?? null,
        hangedRole: voteResult.hanged?.role ?? null,
        nightKillName: nightResult.victim?.name ?? null,
        nightKillSaved: nightResult.saved,
        votes: voteResult.votes.map((v) => ({ voter: v.voterName, target: v.targetName })),
      });

      const winAfterNight = checkWinCondition(playersRef.current);
      if (winAfterNight) {
        gameWinner = winAfterNight;
        setWinner(winAfterNight);
        break;
      }

      currentRound++;
      setRound(currentRound);
      roundRef.current = currentRound;
    }

    // Finalize
    if (!stopFlagRef.current && gameWinner) {
      setPhase("ended");
      addMessage({
        round: currentRound,
        phase: "system",
        playerName: "System",
        content: gameWinner === "villagers"
          ? "GAME OVER: The villagers have found and hanged every last wolf!"
          : "GAME OVER: The wolves have taken over the village!",
      });
    }
    } catch (err) {
      // AbortError is expected when stop is pressed — swallow it
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.error("[mafia] game loop error:", err);
      }
    }

    // Auto-save
    const finalWinner = gameWinner ?? checkWinCondition(playersRef.current);
    saveGame(finalWinner);

    setIsRunning(false);
    setStatusMsg(stopFlagRef.current ? "Stopped" : "Game Over");
  }, [addMessage, generateSpeech, runDaySpeech, runRebuttalSpeech, runFollowUpSpeech, runVotePhase, runNightPhase, saveGame]);

  // ── controls ──

  const generatePreviewPlayers = useCallback(() => {
    const names = pickRandomNames(playerCount);
    const personalities = usePresets
      ? pickRandomPersonalities(playerCount)
      : customPersonalities.length >= playerCount
        ? shuffle(customPersonalities).slice(0, playerCount)
        : pickRandomPersonalities(playerCount);

    setPreviewPlayers(names.map((name, i) => ({
      name,
      personality: personalities[i],
    })));
    setEditingIdx(null);
  }, [playerCount, usePresets, customPersonalities]);

  const handleStart = useCallback(() => {
    if (isRunning) return;
    if (!model) {
      setStatusMsg("Select a model first");
      return;
    }

    // Use preview players if they exist and match count, otherwise generate new
    let namePersonality: Array<{ name: string; personality: string }>;
    if (previewPlayers.length === playerCount) {
      namePersonality = previewPlayers;
    } else {
      const names = pickRandomNames(playerCount);
      const personalities = usePresets
        ? pickRandomPersonalities(playerCount)
        : customPersonalities.length >= playerCount
          ? shuffle(customPersonalities).slice(0, playerCount)
          : pickRandomPersonalities(playerCount);
      namePersonality = names.map((name, i) => ({ name, personality: personalities[i] }));
    }

    // Build roles
    const roles: MafiaRole[] = [];
    for (let i = 0; i < wolfCount; i++) roles.push("wolf");
    if (playerCount >= 6) {
      roles.push("doctor");
      roles.push("detective");
    }
    while (roles.length < playerCount) roles.push("villager");
    const shuffledRoles = shuffle(roles);

    const gamePlayers: MafiaPlayer[] = namePersonality.map(({ name, personality }, i) => ({
      id: crypto.randomUUID(),
      name,
      personality,
      role: shuffledRoles[i],
      alive: true,
      color: pickColor(i),
    }));

    setPlayers(gamePlayers);
    playersRef.current = gamePlayers;
    setMessages([]);
    messagesRef.current = [];
    setRound(0);
    roundRef.current = 0;
    setPhase("day");
    setWinner(null);
    winnerRef.current = null;
    stopFlagRef.current = false;
    abortRef.current = new AbortController();
    lastProtectedRef.current = null;
    detectiveResultsRef.current = [];
    doctorHistoryRef.current = [];
    roundHistoryRef.current = [];
    playerSaidRef.current = new Map();
    setIsRunning(true);
    setStatusMsg("Starting...");
    setPreviewPlayers([]);

    const allNames = gamePlayers.map((p) => p.name).join(", ");
    const specialRoles = playerCount >= 6 ? " A Doctor and Detective walk among them." : "";
    addMessage({
      round: 0,
      phase: "system",
      playerName: "System",
      content: `Game started: ${allNames}. ${wolfCount} wolf${wolfCount > 1 ? "ves" : ""} hide among them.${specialRoles} The village must find them before it's too late.`,
    });

    setTimeout(() => runGame(), 200);
  }, [isRunning, model, playerCount, wolfCount, usePresets, customPersonalities, previewPlayers, addMessage, runGame]);

  const handleStop = useCallback(() => {
    stopFlagRef.current = true;
    abortRef.current?.abort();
    setIsRunning(false);
    setStatusMsg("Stopped");
  }, []);

  // ── derived ──
  const aliveCount = players.filter((p) => p.alive).length;
  const gameOver = phase === "ended" || winner !== null;
  const maxWolves = Math.max(1, Math.floor((playerCount - 1) / 2));

  function roleTagColor(role: MafiaRole): string {
    if (role === "wolf") return "#cc0000";
    if (role === "doctor") return "#0066aa";
    if (role === "detective") return "#886600";
    return "#006600";
  }

  function roleTagLabel(role: MafiaRole): string {
    if (role === "wolf") return "W";
    if (role === "doctor") return "Dr";
    if (role === "detective") return "Det";
    return "V";
  }


  // ── render ──

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#c0c0c0", minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Chat log */}
        <div
          ref={chatContainerRef}
          className="aol-chat w95-deep-inset w95-scrollable"
          style={{ flex: 1, minWidth: 0 }}
          onScroll={() => {
            const el = chatContainerRef.current;
            if (!el) return;
            isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
          }}
        >
          {messages.length === 0 && (
            <>
              <div className="aol-msg aol-msg-system">*** Welcome to Mafia ***</div>
              <div className="aol-msg aol-msg-system">*** Configure settings on the right, then click Start ***</div>
            </>
          )}
          {messages.map((msg) => {
            if (msg.phase === "system") {
              const c = msg.content;
              const cls = c.startsWith("GAME OVER") ? "aol-msg-narrator"
                : c.startsWith("--- DAY") ? "aol-msg-dayheader"
                : c.startsWith("--- NIGHT") ? "aol-msg-nightheader"
                : c.startsWith("--- VOTE") ? "aol-msg-voteheader"
                : c.startsWith("☠") ? "aol-msg-death-kill"
                : c.startsWith("⚖") ? "aol-msg-death-hang"
                : c.startsWith("✚") ? "aol-msg-death-saved"
                : "aol-msg-system";
              return (
                <div key={msg.id} className={`aol-msg ${cls}`}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "vote") {
              const player = players.find((p) => p.id === msg.playerId);
              return (
                <div key={msg.id} className="aol-msg aol-msg-vote">
                  {player && (
                    <span className="aol-name" style={{ color: player.color }}>{msg.playerName}: </span>
                  )}
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "wolf-chat" || msg.phase === "wolf-strategy") {
              const player = players.find((p) => p.id === msg.playerId);
              return (
                <div key={msg.id} className="aol-msg aol-msg-wolf">
                  <span className="aol-name" style={{ color: player?.color }}>{msg.playerName}: </span>
                  {msg.content}
                  {streamingMsgId === msg.id && <span className="aol-cursor" />}
                </div>
              );
            }
            if (msg.phase === "reaction") {
              const player = players.find((p) => p.id === msg.playerId);
              const color = player?.color ?? "#000000";
              return (
                <div key={msg.id} className="aol-msg" style={{ background: "#f0f0f0", borderLeft: "3px solid #666666", fontStyle: "italic" }}>
                  <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                  {msg.content}
                  {streamingMsgId === msg.id && <span className="aol-cursor" />}
                </div>
              );
            }
            if (msg.phase === "doctor") {
              return (
                <div key={msg.id} className="aol-msg" style={{ background: "#e8f4ff", fontStyle: "italic", fontSize: 10, color: "#0066aa" }}>
                  {msg.content}
                </div>
              );
            }
            if (msg.phase === "detective") {
              return (
                <div key={msg.id} className="aol-msg" style={{ background: "#fff8e0", fontStyle: "italic", fontSize: 10, color: "#886600" }}>
                  {msg.content}
                </div>
              );
            }
            // Day speech
            const player = players.find((p) => p.id === msg.playerId);
            const color = player?.color ?? "#000000";
            return (
              <div key={msg.id} className="aol-msg" style={{ background: "#f8f8f8" }}>
                <span className="aol-name" style={{ color }}>{msg.playerName}: </span>
                {msg.content}
                {streamingMsgId === msg.id && <span className="aol-cursor" />}
              </div>
            );
          })}

          {/* Role reveal on game over */}
          {gameOver && players.length > 0 && (
            <div style={{
              margin: "8px 6px", padding: "6px 8px",
              background: "#fffff0", border: "2px solid",
              borderColor: "#808080 #ffffff #ffffff #808080",
            }}>
              <div style={{ fontWeight: "bold", fontSize: 11, marginBottom: 4, color: "#000080" }}>
                ROLE REVEAL
              </div>
              {players.map((p) => (
                <div key={p.id} style={{ fontSize: 11, padding: "1px 0" }}>
                  <span style={{ color: p.color, fontWeight: "bold" }}>{p.name}</span>
                  {" — "}
                  <span style={{
                    color: roleTagColor(p.role),
                    fontWeight: "bold",
                  }}>
                    {p.role.toUpperCase()}
                  </span>
                  {!p.alive && <span style={{ color: "#999" }}> (dead)</span>}
                </div>
              ))}
            </div>
          )}

          <div style={{ height: 1 }} />
        </div>

        {/* Right sidebar */}
        <div style={{
          width: 220, flexShrink: 0, display: "flex", flexDirection: "column",
          borderLeft: "2px solid #808080", overflowY: "auto", background: "#c0c0c0",
        }}>

          {/* Players panel */}
          <div style={{ margin: "6px 6px 4px", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080" }}>
            <div style={{
              background: "#000080", color: "#ffffff", fontSize: 10, fontWeight: "bold",
              padding: "2px 5px", display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>Players</span>
              <span style={{ fontSize: 9, fontWeight: "normal" }}>
                {isRunning || players.length > 0 ? `${aliveCount} alive` : `${playerCount} planned`}
              </span>
            </div>
            <div className="w95-scrollable" style={{ background: "#ffffff", borderTop: "1px solid #808080", maxHeight: 200, overflowY: "auto" }}>
              {/* Pre-game preview players */}
              {!isRunning && players.length === 0 && previewPlayers.length > 0 && (
                <>
                  {previewPlayers.map((pp, idx) => (
                    <div key={idx} style={{ padding: "2px 5px", fontSize: 10 }}>
                      {editingIdx === idx ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            style={{ fontSize: 10, fontWeight: "bold", border: "1px solid #808080", padding: "1px 3px" }}
                          />
                          <input
                            type="text"
                            value={editPersonality}
                            onChange={(e) => setEditPersonality(e.target.value)}
                            style={{ fontSize: 9, border: "1px solid #808080", padding: "1px 3px" }}
                          />
                          <div style={{ display: "flex", gap: 2 }}>
                            <button
                              className="w95-btn"
                              style={{ fontSize: 8, padding: "1px 4px" }}
                              onClick={() => {
                                const updated = [...previewPlayers];
                                updated[idx] = { name: editName.trim() || pp.name, personality: editPersonality.trim() || pp.personality };
                                setPreviewPlayers(updated);
                                setEditingIdx(null);
                              }}
                            >OK</button>
                            <button
                              className="w95-btn"
                              style={{ fontSize: 8, padding: "1px 4px" }}
                              onClick={() => setEditingIdx(null)}
                            >Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={() => {
                            setEditingIdx(idx);
                            setEditName(pp.name);
                            setEditPersonality(pp.personality);
                          }}
                          style={{ cursor: "pointer" }}
                          title="Click to edit"
                        >
                          <span style={{ color: pickColor(idx), fontWeight: "bold" }}>{pp.name}</span>
                          <div style={{ fontSize: 8, color: "#888", lineHeight: 1.2 }}>{pp.personality.slice(0, 60)}...</div>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
              {/* Active game players */}
              {players.filter((p) => p.alive).map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", padding: "2px 5px", gap: 5 }}>
                  <span style={{ color: p.color, fontSize: 9, lineHeight: 1 }}>●</span>
                  <span style={{ fontSize: 11, fontWeight: "bold" }}>{p.name}</span>
                  {gameOver && (
                    <span style={{
                      fontSize: 8, fontWeight: "bold", marginLeft: "auto",
                      color: roleTagColor(p.role),
                    }}>
                      {roleTagLabel(p.role)}
                    </span>
                  )}
                </div>
              ))}
              {players.filter((p) => !p.alive).map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", padding: "2px 5px", gap: 5, opacity: 0.5 }}>
                  <span style={{ color: "#aaa", fontSize: 9, lineHeight: 1 }}>●</span>
                  <span style={{ fontSize: 11, color: "#999", textDecoration: "line-through" }}>{p.name}</span>
                  <span style={{
                    fontSize: 8, fontWeight: "bold", marginLeft: "auto",
                    color: roleTagColor(p.role),
                  }}>
                    {roleTagLabel(p.role)}
                  </span>
                </div>
              ))}
              {/* Empty state */}
              {!isRunning && players.length === 0 && previewPlayers.length === 0 && (
                <div style={{ padding: 8, fontSize: 9, color: "#808080", textAlign: "center" }}>
                  Click &quot;Preview&quot; to see players before starting
                </div>
              )}
            </div>
          </div>

          <div className="w95-divider" style={{ margin: "0 6px" }} />

          {/* Controls */}
          <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 3 }}>
              {!isRunning && players.length === 0 && (
                <button className="w95-btn" onClick={generatePreviewPlayers} style={{ flex: 1, fontSize: 10 }}>
                  Preview
                </button>
              )}
              <button className="w95-btn w95-btn-primary" onClick={handleStart} disabled={isRunning} style={{ flex: 1 }}>
                ▶ Start
              </button>
              <button className="w95-btn" onClick={handleStop} disabled={!isRunning} style={{ flex: 1 }}>
                ■ Stop
              </button>
            </div>

            {/* Players slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>PLAYERS</span>
                <span className="w95-trackbar-value">{playerCount}</span>
              </div>
              <W95Slider
                min={4} max={20} step={1}
                value={playerCount}
                onChange={(v) => { setPlayerCount(Math.round(v)); setPreviewPlayers([]); }}
                disabled={isRunning}
              />
            </div>

            {/* Wolves slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>WOLVES</span>
                <span className="w95-trackbar-value">{wolfCount}</span>
              </div>
              <W95Slider
                min={1} max={9} step={1}
                value={wolfCount}
                onChange={(v) => setWolfCount(Math.round(Math.min(v, maxWolves)))}
                disabled={isRunning}
              />
            </div>

            {/* Max rounds slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>MAX ROUNDS</span>
                <span className="w95-trackbar-value">{maxRounds}</span>
              </div>
              <W95Slider
                min={3} max={15} step={1}
                value={maxRounds}
                onChange={(v) => setMaxRounds(Math.round(v))}
                disabled={isRunning}
              />
            </div>

            {/* Model */}
            <div>
              <div style={{ fontSize: 9, color: "#555", fontWeight: "bold", marginBottom: 2 }}>MODEL</div>
              <select
                className="w95-select"
                style={{ width: "100%", fontSize: 10 }}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {availableModels.length === 0 && <option value="">Loading...</option>}
                {availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {/* Temperature */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>TEMP</span>
                <span className="w95-trackbar-value">{temperature.toFixed(2)}</span>
              </div>
              <W95Slider min={0} max={2} step={0.05} value={temperature} onChange={setTemperature} />
            </div>

            <div className="w95-divider" />

            {/* View buttons */}
            <div style={{ display: "flex", gap: 3 }}>
              <button
                className="w95-btn"
                style={{ flex: 1, fontSize: 10 }}
                onClick={() => { setShowPastGames(true); loadPastGames(); }}
              >
                Past Games
              </button>
              <button
                className="w95-btn"
                style={{ flex: 1, fontSize: 10 }}
                onClick={() => { setShowStats(true); loadPastGames(); }}
              >
                Stats
              </button>
            </div>
            <button
              className="w95-btn"
              style={{ fontSize: 10 }}
              onClick={() => setShowPrompts(true)}
              disabled={players.length === 0}
            >
              Prompts
            </button>

            <div className="w95-divider" />

            {/* Personality controls */}
            <div style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>PERSONALITIES</div>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}>
              <input
                type="radio"
                name="persona"
                checked={usePresets}
                onChange={() => setUsePresets(true)}
                disabled={isRunning}
              />
              Use built-in presets ({PRESET_PERSONALITIES.length})
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}>
              <input
                type="radio"
                name="persona"
                checked={!usePresets}
                onChange={() => setUsePresets(false)}
                disabled={isRunning}
              />
              Custom / generated
              {customPersonalities.length > 0 && ` (${customPersonalities.length})`}
            </label>
            <button
              className="w95-btn"
              style={{ fontSize: 10 }}
              onClick={generatePersonalities}
              disabled={isRunning || isGenerating || !model}
            >
              {isGenerating ? "Generating..." : "Generate New Set"}
            </button>

            {playerCount >= 6 && (
              <div style={{ fontSize: 8, color: "#555", fontStyle: "italic", marginTop: -2 }}>
                Special roles: Doctor + Detective (6+ players)
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="w95-statusbar">
        <span className="w95-status-pane">Round: {round}</span>
        <span className="w95-status-pane">Phase: {phase}</span>
        <span className="w95-status-pane">Alive: {aliveCount}/{players.length || playerCount}</span>
        <span className="w95-status-pane" style={{ flex: 1 }}>{statusMsg}</span>
      </div>

      {/* Past Games Modal */}
      {showPastGames && !viewingRun && (
        <Dialog title="Past Games" onClose={() => setShowPastGames(false)} width={500}>
          <div className="w95-scrollable" style={{ maxHeight: "60vh", overflowY: "auto", background: "#ffffff" }}>
            {pastGames.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: "#808080", fontSize: 11 }}>
                No saved games yet. Games are saved automatically when they end.
              </div>
            )}
            {pastGames.map((run) => {
              const wolfNames = run.players.filter((p) => p.role === "wolf").map((p) => p.name);
              const winLabel = run.winner === "villagers" ? "Villagers won"
                : run.winner === "wolves" ? "Wolves won" : "Unfinished";
              return (
                <div key={run.id} style={{
                  padding: "6px 10px", borderBottom: "1px solid #c0c0c0",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: "bold" }}>
                      {fmtDate(run.savedAt)}
                      <span style={{
                        marginLeft: 8, fontSize: 10, fontWeight: "normal",
                        color: run.winner === "villagers" ? "#006600" : run.winner === "wolves" ? "#cc0000" : "#808080",
                      }}>
                        {winLabel}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: "#555" }}>
                      {run.players.length} players, {run.roundCount} rounds — Wolves: {wolfNames.join(", ")}
                    </div>
                  </div>
                  <button
                    className="w95-btn"
                    style={{ fontSize: 10 }}
                    onClick={() => setViewingRun(run)}
                  >
                    View
                  </button>
                  <button
                    className="w95-btn"
                    style={{ fontSize: 10, minWidth: 30 }}
                    onClick={() => deleteGame(run.id)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </Dialog>
      )}

      {/* Transcript Viewer */}
      {viewingRun && (
        <TranscriptModal
          run={viewingRun}
          onClose={() => { setViewingRun(null); setShowPastGames(false); }}
          onBack={() => { setViewingRun(null); loadPastGames(); }}
        />
      )}

      {/* Prompt Viewer */}
      {showPrompts && players.length > 0 && (
        <PromptViewerModal
          players={players}
          round={round}
          onClose={() => setShowPrompts(false)}
        />
      )}

      {/* Stats Modal */}
      {showStats && (
        <StatsModal
          games={pastGames}
          onClose={() => setShowStats(false)}
        />
      )}
    </div>
  );
}
