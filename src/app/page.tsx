"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type {
  AgentConfig, ConversationTurn, PromptConfig,
  OllamaChunk, PersonalityPreset, SituationPreset, GuidelinesPreset, RunSummary, RunRecord,
} from "@/lib/types";
import {
  buildSystemPrompt, buildChatMessages,
  isLooping, shouldKillerSpeak,
  DEFAULT_BLOCK_ORDER, BLOCK_LABELS,
  type PromptBlock,
} from "@/lib/prompting";
import { cleanOutput } from "@/lib/cleanOutput";

const DEFAULT_MODEL = "dagbs/eva-qwen2.5-32b-v0.0:Q4_K_M";
const MODEL_STORAGE_KEY = "agent-arena-model";
const TEMP_STORAGE_KEY = "agent-arena-temperature";
const NUM_PREDICT_STORAGE_KEY = "agent-arena-num-predict";
const MIN_P_STORAGE_KEY = "agent-arena-min-p";
const CONTEXT_WINDOW_STORAGE_KEY = "agent-arena-context-window";
const DEFAULT_TEMPERATURE = 0.85;
const DEFAULT_NUM_PREDICT = 500;
const DEFAULT_MIN_P = 0.05;
const DEFAULT_CONTEXT_WINDOW = 12;

const AGENT_DOT_COLORS = ["#000099", "#990000", "#555555", "#006600", "#880088"];

// ── helpers ───────────────────────────────────────────────────────────────────

function getMsgClass(agentIndex: number, characters: AgentConfig[]): string {
  const role = characters[agentIndex]?.role;
  if (role === "killer") return "aol-msg-c";
  if (role === "narrator") return "aol-msg-narrator";
  if (agentIndex === 0) return "aol-msg-a";
  if (agentIndex === 1) return "aol-msg-b";
  return agentIndex % 2 === 0 ? "aol-msg-a" : "aol-msg-b";
}

function isSmallModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  if (/\b[1-6](\.\d)?b\b/.test(lower)) return true;
  if (lower.includes("llama3.2") && !/\b[7-9]\d*b\b/.test(lower)) return true;
  return false;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── sub-components ────────────────────────────────────────────────────────────

function W95Slider({ min, max, step, value, onChange }: {
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

function WinBtn({ children, onClick, disabled, primary, style }: {
  children: React.ReactNode; onClick?: () => void;
  disabled?: boolean; primary?: boolean; style?: React.CSSProperties;
}) {
  return (
    <button
      className={`w95-btn${primary ? " w95-btn-primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      {children}
    </button>
  );
}

function Dialog({ title, onClose, children, width }: {
  title: string; onClose: () => void;
  children: React.ReactNode; width?: number;
}) {
  return (
    <div className="w95-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w95-dialog" style={{ width: width ?? 560 }}>
        <div className="w95-titlebar">
          <span style={{ fontSize: 10 }}>■</span>
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

// ── Shared preset row ─────────────────────────────────────────────────────────

/** Dropdown + delete button + name input + Save button — used in every tab. */
function PresetRow({
  options, selected, onSelect, onDelete,
  saveName, onSaveName, onSave, saving, savePlaceholder,
  canDelete,
}: {
  options: { id: string; name: string }[];
  selected: string;
  onSelect: (id: string) => void;
  onDelete: () => void;
  saveName: string;
  onSaveName: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  savePlaceholder?: string;
  canDelete: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", gap: 3 }}>
        <select
          className="w95-select"
          style={{ flex: 1 }}
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="custom">-- Custom --</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {canDelete && (
          <button
            className="w95-btn"
            style={{ minWidth: 0, padding: "1px 6px", fontSize: 10, color: "#800000" }}
            onClick={onDelete}
          >✕</button>
        )}
      </div>
      <div style={{ display: "flex", gap: 3 }}>
        <input
          className="w95-input"
          style={{ flex: 1, fontSize: 10 }}
          placeholder={savePlaceholder ?? "Save current as..."}
          value={saveName}
          onChange={(e) => onSaveName(e.target.value)}
        />
        <WinBtn
          onClick={onSave}
          disabled={saving || !saveName.trim()}
          style={{ minWidth: 0, fontSize: 10, padding: "2px 6px" }}
        >
          {saving ? "…" : "Save"}
        </WinBtn>
      </div>
    </div>
  );
}

// ── Past Runs Modal ───────────────────────────────────────────────────────────

function PastRunsModal({
  runs, onView, onDelete, onClose,
}: {
  runs: RunSummary[]; onView: (id: string) => void;
  onDelete: (id: string) => void; onClose: () => void;
}) {
  return (
    <Dialog title="Past Runs" onClose={onClose} width={520}>
      <div style={{ flex: 1, overflowY: "auto", maxHeight: "60vh" }}>
        {runs.length === 0 && (
          <div style={{ padding: 16, textAlign: "center", color: "#808080", fontSize: 11 }}>
            No saved runs yet. Conversations are auto-saved when you click Stop.
          </div>
        )}
        {runs.map((run) => (
          <div key={run.id} className="preset-row" style={{ alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: "bold", fontSize: 11 }}>
                {run.agentAName} &amp; {run.agentBName}
              </div>
              <div style={{ fontSize: 10, color: "#555" }}>
                {fmtDate(run.savedAt)} · {run.turnCount} turns
              </div>
              {run.situationSnippet && (
                <div style={{ fontSize: 10, color: "#808080", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {run.situationSnippet}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              <button className="w95-btn" style={{ minWidth: 0, fontSize: 10, padding: "2px 8px" }}
                onClick={() => onView(run.id)}>View</button>
              <button className="w95-btn" style={{ minWidth: 0, fontSize: 10, padding: "2px 5px", color: "#800000" }}
                onClick={() => onDelete(run.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: "6px 8px", borderTop: "1px solid #808080", display: "flex", justifyContent: "flex-end" }}>
        <WinBtn onClick={onClose}>Close</WinBtn>
      </div>
    </Dialog>
  );
}

// ── Run Viewer Modal ──────────────────────────────────────────────────────────

function RunViewerModal({ run, onClose }: { run: RunRecord; onClose: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  const [viewTab, setViewTab] = useState<"transcript" | "prompts">("transcript");
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  useEffect(() => { if (viewTab === "transcript") endRef.current?.scrollIntoView(); }, [viewTab]);

  const chars = run.characters ?? ([run.agentA, run.agentB].filter(Boolean) as AgentConfig[]);
  const namesLabel = chars.length > 0
    ? chars.map((c) => c.name).join(", ")
    : `${run.agentAName} & ${run.agentBName}`;

  function getTurnMsgClass(agentIndex: number): string {
    const role = chars[agentIndex]?.role;
    if (role === "killer") return "aol-msg-c";
    if (agentIndex === 0) return "aol-msg-a";
    if (agentIndex === 1) return "aol-msg-b";
    return agentIndex % 2 === 0 ? "aol-msg-a" : "aol-msg-b";
  }

  const blockOrder = (run.promptBlockOrder ?? [...DEFAULT_BLOCK_ORDER]) as PromptBlock[];

  return (
    <Dialog title={`Run: ${namesLabel} — ${fmtDate(run.savedAt)}`} onClose={onClose} width={660}>
      <div style={{ display: "flex", borderBottom: "2px solid #808080", background: "#d4d0c8", padding: "4px 8px 0" }}>
        {(["transcript", "prompts"] as const).map((t) => (
          <button
            key={t}
            className={`w95-tab ${viewTab === t ? "w95-tab-active" : "w95-tab-inactive"}`}
            style={{ padding: "2px 10px", fontSize: 10 }}
            onClick={() => setViewTab(t)}
          >
            {t === "transcript" ? `Transcript (${run.turnCount} turns)` : "Prompts"}
          </button>
        ))}
      </div>

      {viewTab === "transcript" && (
        <div className="aol-chat w95-scrollable" style={{ height: "60vh", flex: "none" }}>
          <div className="aol-msg aol-msg-system">*** {namesLabel} — session started ***</div>
          {run.openingLine && (
            <div className="aol-msg aol-msg-system">*** {run.openingLine} ***</div>
          )}
          {run.turns.map((t, i) => (
            <div key={i}>
              <div
                className={`aol-msg ${getTurnMsgClass(t.agentIndex)}`}
                style={{ cursor: t.systemPrompt ? "pointer" : undefined }}
                onClick={() => {
                  if (!t.systemPrompt) return;
                  setExpandedTurns(prev => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i); else next.add(i);
                    return next;
                  });
                }}
                title={t.systemPrompt ? "Click to view system prompt" : undefined}
              >
                <span className="aol-name">{t.agentName}: </span>
                <span>{t.content}</span>
                {t.systemPrompt && (
                  <span style={{ fontSize: 8, color: "#808080", marginLeft: 4 }}>
                    {expandedTurns.has(i) ? "▼" : "▶"}
                  </span>
                )}
              </div>
              {expandedTurns.has(i) && t.systemPrompt && (
                <pre style={{
                  fontSize: 8, background: "#fffff0", border: "1px solid #c0c0c0",
                  padding: "4px 6px", margin: "0 8px 4px", whiteSpace: "pre-wrap",
                  lineHeight: 1.3, color: "#444", maxHeight: 200, overflowY: "auto",
                }}>{t.systemPrompt}</pre>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {viewTab === "prompts" && (
        <div className="w95-scrollable" style={{ height: "60vh", padding: "8px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 16, fontSize: 9, color: "#555" }}>
            <span>Temperature: <strong>{run.temperature ?? "—"}</strong></span>
            <span>Turns: <strong>{run.turnCount}</strong></span>
            <span>Saved: <strong>{fmtDate(run.savedAt)}</strong></span>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080", marginBottom: 4 }}>PROMPT ASSEMBLY ORDER</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              {blockOrder.map((b, i) => (
                <span key={b} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{
                    fontSize: 9, fontWeight: "bold", padding: "2px 6px",
                    border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
                    background: "#d8d8d8",
                  }}>{BLOCK_LABELS[b] ?? b}</span>
                  {i < blockOrder.length - 1 && <span style={{ fontSize: 9, color: "#808080" }}>→</span>}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080", marginBottom: 2 }}>GUIDELINES</div>
            <pre style={{
              fontSize: 9, background: "#ffffff", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              padding: "4px 6px", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.4, color: "#000",
              maxHeight: 120, overflowY: "auto",
            }}>{run.guidelines || "(none)"}</pre>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080", marginBottom: 2 }}>SITUATION</div>
            <pre style={{
              fontSize: 9, background: "#ffffff", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              padding: "4px 6px", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.4, color: "#000",
              maxHeight: 150, overflowY: "auto",
            }}>{run.situation || "(none)"}</pre>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080", marginBottom: 2 }}>OPENING LINE</div>
            <div style={{
              fontSize: 9, background: "#ffffff", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
              padding: "4px 6px", color: "#000",
            }}>{run.openingLine || "(none)"}</div>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080", marginBottom: 4 }}>CHARACTERS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {chars.map((c, i) => (
                <div key={i} style={{
                  border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
                  background: "#e8e8e8", padding: "5px 7px",
                }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: "bold" }}>{c.name}</span>
                    <span style={{ fontSize: 9, color: "#555" }}>role: {c.role ?? "character"}</span>
                    <span style={{ fontSize: 9, color: "#555", marginLeft: "auto" }}>model: <strong>{c.model}</strong></span>
                  </div>
                  {c.primer && (
                    <div style={{ fontSize: 9, color: "#555", marginBottom: 3 }}>
                      Primer: <em>&ldquo;{c.primer}&rdquo;</em>
                    </div>
                  )}
                  <pre style={{
                    fontSize: 9, background: "#ffffff", border: "1px solid #c0c0c0",
                    padding: "3px 5px", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.4, color: "#000",
                    maxHeight: 100, overflowY: "auto",
                  }}>{c.systemPrompt || "(none)"}</pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: "6px 8px", borderTop: "1px solid #808080", display: "flex", justifyContent: "flex-end" }}>
        <WinBtn onClick={onClose}>Close</WinBtn>
      </div>
    </Dialog>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

type SetupTab = "model" | "guidelines" | "characters" | "situation" | "assembly";
type ModalType = "runs" | "run-viewer" | null;

const TABS: { id: SetupTab; label: string }[] = [
  { id: "model", label: "General" },
  { id: "guidelines", label: "Guidelines" },
  { id: "characters", label: "Characters" },
  { id: "situation", label: "Situation" },
  { id: "assembly", label: "Assembly" },
];

export default function Home() {
  const [characters, setCharacters] = useState<AgentConfig[]>(() => {
    const m = typeof window !== "undefined" ? (localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL) : DEFAULT_MODEL;
    return [
      { name: "Agent A", systemPrompt: "", model: m, role: "character" },
      { name: "Agent B", systemPrompt: "", model: m, role: "character" },
    ];
  });
  const [guidelines, setGuidelines] = useState("");
  const [situation, setSituation] = useState("");
  const [openingLine, setOpeningLine] = useState("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Ready.");
  const [availableModels, setAvailableModels] = useState<string[]>([DEFAULT_MODEL]);

  // Setup panel
  const [setupTab, setSetupTab] = useState<SetupTab>("model");
  const [characterTab, setCharacterTab] = useState(0);

  // Library presets
  const [personalities, setPersonalities] = useState<PersonalityPreset[]>([]);
  const [situations, setSituationPresets] = useState<SituationPreset[]>([]);
  const [guidelinesPresets, setGuidelinesPresets] = useState<GuidelinesPreset[]>([]);

  // Preset dropdown selections
  const [selectedCharacterPreset, setSelectedCharacterPresets] = useState<string[]>(["custom", "custom"]);
  const [selectedSitPreset, setSelectedSitPreset] = useState("custom");
  const [selectedGuidelinesPreset, setSelectedGuidelinesPreset] = useState("custom");

  // Preset save state — one per tab
  const [guidelinesPresetName, setGuidelinesPresetName] = useState("");
  const [savingGuidelinesPreset, setSavingGuidelinesPreset] = useState(false);
  const [characterPresetName, setCharacterPresetName] = useState("");
  const [savingCharacterPreset, setSavingCharacterPreset] = useState(false);
  const [situationPresetName, setSituationPresetName] = useState("");
  const [savingSituationPreset, setSavingSituationPreset] = useState(false);

  // Saved configs (user-created only)
  const [savedConfigs, setSavedConfigs] = useState<PromptConfig[]>([]);
  const [configName, setConfigName] = useState("");

  // Past runs
  const [pastRuns, setPastRuns] = useState<RunSummary[]>([]);
  const [viewingRun, setViewingRun] = useState<RunRecord | null>(null);

  // Modals
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [infoExpanded, setInfoExpanded] = useState<number | null>(null);

  // Prompt assembly order
  const [promptBlockOrder, setPromptBlockOrder] = useState<PromptBlock[]>([...DEFAULT_BLOCK_ORDER]);

  // Refs for run loop
  const stopFlagRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<ConversationTurn[]>([]);
  const runStartTimeRef = useRef<number | null>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const charactersRef = useRef<AgentConfig[]>([]);
  const guidelinesRef = useRef("");
  const situationRef = useRef(situation);
  const openingLineRef = useRef(openingLine);
  const promptBlockOrderRef = useRef<PromptBlock[]>([...DEFAULT_BLOCK_ORDER]);
  const temperatureRef = useRef(DEFAULT_TEMPERATURE);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  useEffect(() => { guidelinesRef.current = guidelines; }, [guidelines]);
  useEffect(() => { promptBlockOrderRef.current = promptBlockOrder; }, [promptBlockOrder]);
  useEffect(() => { situationRef.current = situation; }, [situation]);
  useEffect(() => { openingLineRef.current = openingLine; }, [openingLine]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  const [temperature, setTemperatureState] = useState<number>(() =>
    typeof window !== "undefined"
      ? parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) ?? String(DEFAULT_TEMPERATURE))
      : DEFAULT_TEMPERATURE
  );

  function setTemperature(t: number) {
    localStorage.setItem(TEMP_STORAGE_KEY, String(t));
    temperatureRef.current = t;
    setTemperatureState(t);
  }

  const [numPredict, setNumPredictState] = useState<number>(() =>
    typeof window !== "undefined"
      ? parseInt(localStorage.getItem(NUM_PREDICT_STORAGE_KEY) ?? String(DEFAULT_NUM_PREDICT))
      : DEFAULT_NUM_PREDICT
  );
  const numPredictRef = useRef(numPredict);
  function setNumPredict(n: number) {
    localStorage.setItem(NUM_PREDICT_STORAGE_KEY, String(n));
    numPredictRef.current = n;
    setNumPredictState(n);
  }

  const [minP, setMinPState] = useState<number>(() =>
    typeof window !== "undefined"
      ? parseFloat(localStorage.getItem(MIN_P_STORAGE_KEY) ?? String(DEFAULT_MIN_P))
      : DEFAULT_MIN_P
  );
  const minPRef = useRef(minP);
  function setMinP(v: number) {
    localStorage.setItem(MIN_P_STORAGE_KEY, String(v));
    minPRef.current = v;
    setMinPState(v);
  }

  const [contextWindow, setContextWindowState] = useState<number>(() =>
    typeof window !== "undefined"
      ? parseInt(localStorage.getItem(CONTEXT_WINDOW_STORAGE_KEY) ?? String(DEFAULT_CONTEXT_WINDOW))
      : DEFAULT_CONTEXT_WINDOW
  );
  const contextWindowRef = useRef(contextWindow);
  function setContextWindow(n: number) {
    localStorage.setItem(CONTEXT_WINDOW_STORAGE_KEY, String(n));
    contextWindowRef.current = n;
    setContextWindowState(n);
  }

  function setAllModels(m: string) {
    localStorage.setItem(MODEL_STORAGE_KEY, m);
    setCharacters((prev) => prev.map((c) => ({ ...c, model: m })));
  }

  // ── data loaders ──────────────────────────────────────────────────────────

  const loadConfigs = useCallback(async () => {
    try {
      const r = await fetch("/api/prompts");
      const { configs } = await r.json() as { configs: PromptConfig[] };
      setSavedConfigs(configs);
    } catch { /* ignore */ }
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const [pRes, sRes, gRes] = await Promise.all([
        fetch("/api/personalities"),
        fetch("/api/situations"),
        fetch("/api/guidelines"),
      ]);
      const { personalities: p } = await pRes.json() as { personalities: PersonalityPreset[] };
      const { situations: s } = await sRes.json() as { situations: SituationPreset[] };
      const { guidelines: g } = await gRes.json() as { guidelines: GuidelinesPreset[] };
      setPersonalities(p);
      setSituationPresets(s);
      setGuidelinesPresets(g);
    } catch { /* ignore */ }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch("/api/runs");
      const { runs } = await r.json() as { runs: RunSummary[] };
      setPastRuns(runs);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetch("/api/models").then((r) => r.json())
      .then(({ models }: { models: string[] }) => {
        if (models.length > 0) {
          setAvailableModels(models);
          setCharacters((prev) => prev.map((c) => ({
            ...c,
            model: models.includes(c.model) ? c.model : models[0],
          })));
        }
      })
      .catch(() => {});
    loadConfigs();
    loadLibrary();
    loadRuns();
  }, [loadConfigs, loadLibrary, loadRuns]);

  useEffect(() => {
    if (isAtBottomRef.current) {
      conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [turns]);

  useEffect(() => {
    if (characterTab >= characters.length) {
      setCharacterTab(Math.max(0, characters.length - 1));
    }
  }, [characters.length, characterTab]);

  // ── save run ──────────────────────────────────────────────────────────────

  const saveRun = useCallback(async (
    completedTurns: ConversationTurn[],
    chars: AgentConfig[],
    sit: string,
    guide: string,
    opening: string,
    temp: number,
    blockOrder: PromptBlock[],
    nPredict: number,
    mP: number,
    ctxWindow: number,
  ) => {
    if (completedTurns.length === 0) return;
    const id = Date.now().toString();
    const run: RunRecord = {
      id, savedAt: new Date().toISOString(),
      agentAName: chars[0]?.name ?? "Agent A",
      agentBName: chars[1]?.name ?? "Agent B",
      characters: chars,
      turnCount: completedTurns.filter((t) => !t.isStreaming).length,
      situation: sit,
      guidelines: guide,
      openingLine: opening,
      temperature: temp,
      promptBlockOrder: blockOrder,
      numPredict: nPredict,
      minP: mP,
      contextWindow: ctxWindow,
      situationSnippet: sit.slice(0, 100),
      turns: completedTurns.filter((t) => !t.isStreaming).map(({ systemPrompt: _sp, ...t }) => t),
    };
    await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(run) });
    loadRuns();
  }, [loadRuns]);

  // ── run loop ──────────────────────────────────────────────────────────────

  const runLoop = useCallback(async (agentIndex: number, historyIn: ConversationTurn[]) => {
    if (stopFlagRef.current) {
      setIsRunning(false);
      setStatusMsg("Session ended.");
      await saveRun(historyIn, charactersRef.current, situationRef.current, guidelinesRef.current, openingLineRef.current, temperatureRef.current, promptBlockOrderRef.current, numPredictRef.current, minPRef.current, contextWindowRef.current);
      return;
    }

    const speaking = charactersRef.current[agentIndex];
    if (!speaking) {
      setIsRunning(false);
      setStatusMsg("Error: invalid agent index.");
      return;
    }

    if (speaking.role === "killer") {
      if (!shouldKillerSpeak(agentIndex, charactersRef.current, historyIn)) {
        runLoop((agentIndex + 1) % charactersRef.current.length, historyIn);
        return;
      }
    }

    setStatusMsg(`${speaking.name} is typing...`);

    const newTurn: ConversationTurn = { agentIndex, agentName: speaking.name, content: "", isStreaming: true };
    setTurns([...historyIn, newTurn]);

    const system = buildSystemPrompt(speaking, situationRef.current, guidelinesRef.current, promptBlockOrderRef.current, charactersRef.current);
    const messages = buildChatMessages(historyIn, agentIndex, charactersRef.current, openingLineRef.current, contextWindowRef.current);

    try {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: speaking.model, system, messages,
          temperature: temperatureRef.current,
          numPredict: speaking.numPredict ?? numPredictRef.current,
          minP: minPRef.current,
          stop: charactersRef.current
            .filter((c) => c.name !== speaking.name)
            .map((c) => `${c.name}:`),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stopFlagRef.current) { reader.cancel(); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed) as OllamaChunk;
            if (chunk.message?.content) {
              fullContent += chunk.message.content;
              setTurns((prev) => {
                const next = [...prev];
                const speakerEscaped = speaking.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const display = fullContent
                  .replace(/<think>[\s\S]*?<\/think>/gi, "")
                  .replace(/<think>[\s\S]*/i, "…")
                  .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "")
                  .replace(/<\|thinking\|>[\s\S]*/i, "…")
                  .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
                  .replace(/<reasoning>[\s\S]*/i, "…")
                  .replace(new RegExp(`^\\s*${speakerEscaped}\\s*:\\s*`, "i"), "")
                  .trim();
                next[next.length - 1] = { ...next[next.length - 1], content: display || "…" };
                return next;
              });
            }
            if (chunk.done) break;
          } catch { /* partial line */ }
        }
      }

      const allNames = charactersRef.current.map(c => c.name);
      const cleaned = cleanOutput(fullContent, speaking.name, allNames);
      if (!cleaned) {
        runLoop(agentIndex, historyIn);
        return;
      }
      const completedTurn: ConversationTurn = { agentIndex, agentName: speaking.name, content: cleaned, isStreaming: false, systemPrompt: system };
      const finalHistory = [...historyIn, completedTurn];
      setTurns(finalHistory);

      if (stopFlagRef.current) {
        setIsRunning(false);
        setStatusMsg("Session ended.");
        await saveRun(finalHistory, charactersRef.current, situationRef.current, guidelinesRef.current, openingLineRef.current, temperatureRef.current, promptBlockOrderRef.current, numPredictRef.current, minPRef.current, contextWindowRef.current);
        return;
      }

      if (isLooping(finalHistory)) {
        setIsRunning(false);
        setStatusMsg("Stopped: conversation looped.");
        await saveRun(finalHistory, charactersRef.current, situationRef.current, guidelinesRef.current, openingLineRef.current, temperatureRef.current, promptBlockOrderRef.current, numPredictRef.current, minPRef.current, contextWindowRef.current);
        return;
      }

      if (speaking.role === "killer") {
        if (/\bRESOLVED\b/i.test(cleaned)) {
          setIsRunning(false);
          setStatusMsg("Resolved. The Killer has made their decision.");
          await saveRun(finalHistory, charactersRef.current, situationRef.current, guidelinesRef.current, openingLineRef.current, temperatureRef.current, promptBlockOrderRef.current, numPredictRef.current, minPRef.current, contextWindowRef.current);
          return;
        }
      }

      runLoop((agentIndex + 1) % charactersRef.current.length, finalHistory);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // handleStop already saved
      const msg = err instanceof Error ? err.message : "Unknown error";
      setStatusMsg(`Error: ${msg}`);
      setIsRunning(false);
      setTurns((prev) => {
        const next = [...prev];
        if (next.length > 0) next[next.length - 1] = { ...next[next.length - 1], content: `[Error: ${msg}]`, isStreaming: false };
        return next;
      });
    }
  }, [saveRun]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── handlers ──────────────────────────────────────────────────────────────

  function handleStart() {
    stopFlagRef.current = false;
    runStartTimeRef.current = Date.now();
    setIsRunning(true);
    setStatusMsg("Starting session...");

    const chars = charactersRef.current;
    const seeded: ConversationTurn[] = [];
    for (let i = 0; i < chars.length; i++) {
      if (chars[i]?.primer) {
        seeded.push({ agentIndex: i, agentName: chars[i].name, content: chars[i].primer!, isStreaming: false });
      } else {
        break;
      }
    }
    if (seeded.length > 0) {
      setTurns(seeded);
      runLoop(seeded.length % chars.length, seeded);
    } else {
      setTurns([]);
      runLoop(0, []);
    }
  }

  function handleStop() {
    stopFlagRef.current = true;
    abortControllerRef.current?.abort();
    setIsRunning(false);
    setStatusMsg("Session ended.");
    const finalTurns = turnsRef.current
      .map(t => t.isStreaming ? { ...t, isStreaming: false } : t)
      .filter(t => t.content.trim());
    setTurns(finalTurns);
    saveRun(finalTurns, charactersRef.current, situationRef.current, guidelinesRef.current, openingLineRef.current, temperatureRef.current, promptBlockOrderRef.current, numPredictRef.current, minPRef.current, contextWindowRef.current);
  }

  // ── config save/load ──────────────────────────────────────────────────────

  async function handleSaveConfig() {
    if (!configName.trim()) return;
    const config: PromptConfig = {
      name: configName,
      characters,
      guidelines,
      situation,
      promptBlockOrder,
      savedAt: new Date().toISOString(),
    };
    await fetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    loadConfigs();
  }

  async function handleLoadConfig(cfg: PromptConfig) {
    const chars = cfg.characters ?? ([cfg.agentA, cfg.agentB].filter(Boolean) as AgentConfig[]);
    const currentModel = characters[0]?.model ?? DEFAULT_MODEL;
    setCharacters(chars.map((c, i) => ({ ...c, model: characters[i]?.model ?? currentModel })));
    setGuidelines(cfg.guidelines ?? "");
    setSituation(cfg.situation);
    if (cfg.promptBlockOrder && cfg.promptBlockOrder.length > 0) {
      setPromptBlockOrder(cfg.promptBlockOrder as PromptBlock[]);
    }
    const matchedSit = situations.find((s) => s.situation === cfg.situation);
    setOpeningLine(matchedSit?.openingLine ?? "");
    setConfigName(cfg.name);

    // Upsert any config characters that already exist in the personality library (matched by name).
    // This keeps the library in sync with the config so the dropdown shows the correct name
    // and selecting it doesn't overwrite the prompt with a stale version.
    const nameMatches = chars.filter((c) => personalities.some((p) => p.name === c.name));
    let freshPersonalities = personalities;
    if (nameMatches.length > 0) {
      await Promise.all(nameMatches.map(async (c) => {
        const existing = personalities.find((p) => p.name === c.name)!;
        await fetch("/api/personalities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: c.name, description: existing.description ?? "", systemPrompt: c.systemPrompt, role: c.role, primer: c.primer }),
        });
      }));
      const pRes = await fetch("/api/personalities");
      const { personalities: p } = await pRes.json() as { personalities: PersonalityPreset[] };
      freshPersonalities = p;
      setPersonalities(p);
    }

    const presets = chars.map((c) => {
      const match = freshPersonalities.find((p) => p.systemPrompt === c.systemPrompt);
      return match ? match.id : "custom";
    });
    setSelectedCharacterPresets(presets);
    setCharacterTab(0);
    const matchSit = situations.find((s) => s.situation === cfg.situation);
    setSelectedSitPreset(matchSit ? matchSit.id : "custom");
    const matchG = guidelinesPresets.find((g) => g.guidelines === (cfg.guidelines ?? ""));
    setSelectedGuidelinesPreset(matchG ? matchG.id : "custom");
  }

  async function handleDeleteConfig(name: string) {
    await fetch(`/api/prompts/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadConfigs();
  }

  // ── guidelines presets ────────────────────────────────────────────────────

  function handleGuidelinesPresetSelect(id: string) {
    setSelectedGuidelinesPreset(id);
    if (id !== "custom") {
      const g = guidelinesPresets.find((p) => p.id === id);
      if (g) setGuidelines(g.guidelines);
    }
  }

  async function handleSaveGuidelinesPreset() {
    if (!guidelinesPresetName.trim()) return;
    setSavingGuidelinesPreset(true);
    await fetch("/api/guidelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: guidelinesPresetName, guidelines }),
    });
    setSavingGuidelinesPreset(false);
    setGuidelinesPresetName("");
    loadLibrary();
  }

  async function handleDeleteGuidelinesPreset(id: string) {
    await fetch(`/api/guidelines/${encodeURIComponent(id)}`, { method: "DELETE" });
    setSelectedGuidelinesPreset("custom");
    loadLibrary();
  }

  // ── character presets ─────────────────────────────────────────────────────

  function handleCharPresetSelect(charIdx: number, id: string) {
    const next = [...selectedCharacterPreset];
    while (next.length <= charIdx) next.push("custom");
    next[charIdx] = id;
    setSelectedCharacterPresets(next);
    if (id !== "custom") {
      const p = personalities.find((p) => p.id === id);
      if (p) {
        setCharacters((prev) => {
          const updated = [...prev];
          updated[charIdx] = { ...updated[charIdx], name: p.name, systemPrompt: p.systemPrompt, role: p.role ?? "character" };
          return updated;
        });
      }
    }
  }

  async function handleSaveCharacterPreset(charIdx: number) {
    const char = characters[charIdx];
    if (!char || !char.name.trim()) return;
    setSavingCharacterPreset(true);
    await fetch("/api/personalities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: characterPresetName || char.name, description: "", systemPrompt: char.systemPrompt }),
    });
    setSavingCharacterPreset(false);
    setCharacterPresetName("");
    loadLibrary();
  }

  async function handleDeleteCharacterPreset(id: string) {
    await fetch(`/api/personalities/${encodeURIComponent(id)}`, { method: "DELETE" });
    handleCharPresetSelect(characterTab, "custom");
    loadLibrary();
  }

  // ── situation presets ─────────────────────────────────────────────────────

  function handleSitPresetSelect(id: string) {
    setSelectedSitPreset(id);
    if (id !== "custom") {
      const s = situations.find((s) => s.id === id);
      if (s) {
        setSituation(s.situation);
        setOpeningLine(s.openingLine ?? "");
        if (s.guidelines) setGuidelines(s.guidelines);
        if (s.promptBlockOrder && s.promptBlockOrder.length > 0) {
          setPromptBlockOrder(s.promptBlockOrder as PromptBlock[]);
        }
      }
    }
  }

  async function handleSaveSituationPreset() {
    if (!situationPresetName.trim()) return;
    setSavingSituationPreset(true);
    await fetch("/api/situations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: situationPresetName, description: "", situation, openingLine, promptBlockOrder }),
    });
    setSavingSituationPreset(false);
    setSituationPresetName("");
    loadLibrary();
  }

  async function handleDeleteSituationPreset(id: string) {
    await fetch(`/api/situations/${encodeURIComponent(id)}`, { method: "DELETE" });
    setSelectedSitPreset("custom");
    loadLibrary();
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async function handleViewRun(id: string) {
    const res = await fetch(`/api/runs/${id}`);
    const run = await res.json() as RunRecord;
    setViewingRun(run);
    setActiveModal("run-viewer");
  }

  async function handleDeleteRun(id: string) {
    await fetch(`/api/runs/${id}`, { method: "DELETE" });
    loadRuns();
  }

  const displayModel = characters[0]?.model ?? DEFAULT_MODEL;

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: "#c0c0c0" }}
      className="w95-raise">

      {/* Title Bar */}
      <div className="w95-titlebar">
        <span>Agent Arena</span>
        <div className="w95-winctrls">
          <button className="w95-winbtn">_</button>
          <button className="w95-winbtn">□</button>
          <button className="w95-winbtn">✕</button>
        </div>
      </div>

      {/* Main area: chat + sidebar */}
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
          {turns.length === 0 && (
            <>
              <div className="aol-msg aol-msg-system">*** Welcome to Agent Arena ***</div>
              <div className="aol-msg aol-msg-system">*** Configure agents on the right, then click Start ***</div>
            </>
          )}
          {turns.length > 0 && (
            <>
              <div className="aol-msg aol-msg-system">
                *** {characters.map((c) => c.name).join(", ")} — session started ***
              </div>
              {situation.trim() && (
                <div className="aol-msg aol-msg-system" style={{ whiteSpace: "pre-wrap", fontStyle: "italic" }}>
                  {situation.trim()}
                </div>
              )}
              {openingLine.trim() && (
                <div className="aol-msg aol-msg-system">*** {openingLine.trim()} ***</div>
              )}
            </>
          )}
          {turns.map((turn, i) => (
            <div key={i} className={`aol-msg ${getMsgClass(turn.agentIndex, characters)}`}>
              <span className="aol-name">{turn.agentName}: </span>
              <span>{turn.content}</span>
              {turn.isStreaming && <span className="aol-cursor" />}
            </div>
          ))}
          <div ref={conversationEndRef} />
        </div>

        {/* Right sidebar */}
        <div className="w95-scrollable" style={{
          width: 300, flexShrink: 0, display: "flex", flexDirection: "column",
          borderLeft: "2px solid #808080", overflowY: "auto", background: "#c0c0c0",
        }}>

          {/* People Here */}
          <div style={{ margin: "6px 6px 4px", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080" }}>
            <div style={{
              background: "#000080", color: "#ffffff", fontSize: 10, fontWeight: "bold",
              padding: "2px 5px", display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>People Here</span>
              <span style={{ fontSize: 9, fontWeight: "normal" }}>{turns.length > 0 ? `${characters.length} online` : "0 online"}</span>
            </div>
            <div style={{ background: "#ffffff", borderTop: "1px solid #808080" }}>
              {characters.map((agent, idx) => {
                const dot = AGENT_DOT_COLORS[idx] ?? "#555555";
                const matchedPersonality = personalities.find((p) => p.systemPrompt === agent.systemPrompt);
                return (
                  <div key={idx}>
                    <div style={{
                      display: "flex", alignItems: "center", padding: "3px 5px", gap: 5,
                      background: infoExpanded === idx ? "#dde3ff" : "transparent",
                    }}>
                      <span style={{ color: dot, fontSize: 9, lineHeight: 1 }}>●</span>
                      <span style={{ flex: 1, fontSize: 11, fontWeight: "bold", color: turns.length > 0 ? "#000000" : "#808080" }}>
                        {agent.name}
                        {agent.role === "killer" && (
                          <span style={{ fontSize: 9, color: "#666", fontWeight: "normal", marginLeft: 4 }}>[killer]</span>
                        )}
                      </span>
                      <button
                        onClick={() => setInfoExpanded(infoExpanded === idx ? null : idx)}
                        title="Character info"
                        style={{
                          fontSize: 9, lineHeight: "13px", padding: "0 3px", cursor: "pointer",
                          background: "#c0c0c0", border: "1px solid", fontWeight: "bold",
                          borderColor: infoExpanded === idx ? "#808080 #ffffff #ffffff #808080" : "#ffffff #808080 #808080 #ffffff",
                          color: "#000080",
                        }}
                      >i</button>
                    </div>
                    {infoExpanded === idx && (
                      <div style={{
                        padding: "5px 8px 6px", fontSize: 10, background: "#f4f4f8",
                        borderTop: "1px solid #c0c0c0", borderBottom: "1px solid #c0c0c0",
                      }}>
                        <div style={{ fontWeight: "bold", fontSize: 11, marginBottom: 2 }}>{agent.name}</div>
                        {matchedPersonality?.description ? (
                          <div style={{ color: "#333", lineHeight: 1.4, marginBottom: 4 }}>{matchedPersonality.description}</div>
                        ) : agent.systemPrompt ? (
                          <div style={{ color: "#555", lineHeight: 1.4, marginBottom: 4, fontStyle: "italic" }}>
                            {agent.systemPrompt.slice(0, 180)}{agent.systemPrompt.length > 180 ? "…" : ""}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 9, color: "#808080", marginTop: 4 }}>
                          Model: {agent.model.split(":")[0].split("/").pop()}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {isRunning && (
                <div style={{ fontSize: 9, color: "#808080", fontStyle: "italic", padding: "2px 5px 3px" }}>{statusMsg}</div>
              )}
              <div style={{ borderTop: "1px solid #d0d0d0" }} />
              <div style={{ padding: "4px 6px 5px" }}>
                <div style={{ fontSize: 9, fontWeight: "bold", color: "#000080", textTransform: "uppercase", marginBottom: 3, letterSpacing: "0.5px" }}>
                  The Situation
                </div>
                <div style={{ fontSize: 9, color: situation.trim() ? "#333" : "#aaa", lineHeight: 1.5, maxHeight: 90, overflowY: "auto", fontStyle: situation.trim() ? "normal" : "italic" }}>
                  {situation.trim() || "No situation set."}
                </div>
              </div>
            </div>
          </div>

          <div className="w95-divider" style={{ margin: "0 6px" }} />

          {/* Start / Stop / History */}
          <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", gap: 3 }}>
              <WinBtn onClick={handleStart} disabled={isRunning} primary style={{ flex: 1 }}>▶ Start</WinBtn>
              <WinBtn onClick={handleStop} disabled={!isRunning} style={{ flex: 1 }}>■ Stop</WinBtn>
            </div>
            <div style={{ display: "flex", gap: 3 }}>
              <WinBtn onClick={() => { setActiveModal("runs"); loadRuns(); }} style={{ flex: 1 }}>
                📁 Past Runs {pastRuns.length > 0 ? `(${pastRuns.length})` : ""}
              </WinBtn>
              <a href="/optimize" style={{ flex: 1, textDecoration: "none" }}>
                <WinBtn style={{ width: "100%" }}>⚙ Evolve</WinBtn>
              </a>
            </div>
          </div>

          {/* Save / Load config */}
          <div style={{ padding: "2px 6px 6px", display: "flex", flexDirection: "column", gap: 3 }}>
            {savedConfigs.length > 0 && (
              <>
                <div style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>LOAD CONFIG:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                  {savedConfigs.map((cfg) => (
                    <div key={cfg.name} style={{ display: "flex", gap: 1 }}>
                      <button className="w95-btn" style={{ minWidth: 0, fontSize: 10, padding: "2px 5px" }}
                        onClick={() => handleLoadConfig(cfg)}>{cfg.name}</button>
                      <button className="w95-btn" style={{ minWidth: 0, fontSize: 9, padding: "1px 4px", color: "#800000" }}
                        onClick={() => handleDeleteConfig(cfg.name)}>✕</button>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 3 }}>
              <input className="w95-input" style={{ flex: 1, fontSize: 10 }} placeholder="Save current config as..."
                value={configName} onChange={(e) => setConfigName(e.target.value)} />
              <WinBtn onClick={handleSaveConfig} disabled={!configName.trim()}
                style={{ minWidth: 0, fontSize: 10, padding: "2px 6px" }}>Save</WinBtn>
            </div>
          </div>

          <div className="w95-divider" style={{ margin: "0 6px" }} />

          {/* Setup tabs */}
          <div style={{ padding: "4px 6px 0" }}>
            <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080", marginBottom: 4 }}>SETUP</div>
            <div style={{ display: "flex", borderBottom: "2px solid #808080", flexWrap: "wrap" }}>
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  className={`w95-tab ${setupTab === id ? "w95-tab-active" : "w95-tab-inactive"}`}
                  style={{ padding: "3px 6px", fontSize: 10 }}
                  onClick={() => setSetupTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── General tab ── */}
          {setupTab === "model" && (
            <div style={{ padding: "6px", display: "flex", flexDirection: "column", gap: 4 }}>

              <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080" }}>SET ALL AGENTS&apos; MODEL</div>
              <select className="w95-select" style={{ width: "100%" }} value={displayModel}
                onChange={(e) => setAllModels(e.target.value)}>
                {availableModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {isSmallModel(displayModel) && (
                <div style={{ fontSize: 9, color: "#800000", background: "#fff0f0", border: "1px solid #cc0000", padding: "3px 5px" }}>
                  ⚠ Small models (&lt;7B) struggle with multi-turn roleplay. Use a 30B+ model for best results.
                </div>
              )}

              <div className="w95-divider" />

              <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080" }}>TEMPERATURE</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <W95Slider min={0} max={2} step={0.05} value={temperature} onChange={setTemperature} />
                <span className="w95-trackbar-value">{temperature.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 9, color: "#808080" }}>
                Low = focused &amp; repetitive &nbsp;·&nbsp; High = creative &amp; chaotic
              </div>

              <div className="w95-divider" />

              <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080" }}>MIN_P</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <W95Slider min={0} max={0.2} step={0.01} value={minP} onChange={setMinP} />
                <span className="w95-trackbar-value">{minP.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 9, color: "#808080" }}>
                Filters low-probability tokens. 0 = off, 0.05–0.1 = recommended.
              </div>

              <div className="w95-divider" />

              <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080" }}>CONTEXT WINDOW (TURNS)</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <W95Slider min={4} max={30} step={2} value={contextWindow} onChange={setContextWindow} />
                <span className="w95-trackbar-value">{contextWindow}</span>
              </div>
              <div style={{ fontSize: 9, color: "#808080" }}>
                Recent turns sent to model. Lower = less repetition, higher = more memory.
              </div>

            </div>
          )}

          {/* ── Guidelines tab ── */}
          {setupTab === "guidelines" && (
            <div style={{ padding: "6px", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080" }}>ORIENTATION / GUIDELINES</div>
              <PresetRow
                options={guidelinesPresets}
                selected={selectedGuidelinesPreset}
                onSelect={handleGuidelinesPresetSelect}
                onDelete={() => handleDeleteGuidelinesPreset(selectedGuidelinesPreset)}
                canDelete={selectedGuidelinesPreset !== "custom" && !guidelinesPresets.find((g) => g.id === selectedGuidelinesPreset)?.isBuiltIn}
                saveName={guidelinesPresetName}
                onSaveName={setGuidelinesPresetName}
                onSave={handleSaveGuidelinesPreset}
                saving={savingGuidelinesPreset}
                savePlaceholder="Save current guidelines as..."
              />
              <div style={{ fontSize: 9, color: "#555", lineHeight: 1.5 }}>
                Format rules and behavioral instructions sent to every character agent.
              </div>
              <textarea
                className="w95-textarea"
                rows={12}
                placeholder="Enter format rules, tone instructions, and behavioral guidelines..."
                value={guidelines}
                onChange={(e) => {
                  setGuidelines(e.target.value);
                  setSelectedGuidelinesPreset("custom");
                }}
              />
            </div>
          )}

          {/* ── Characters tab ── */}
          {setupTab === "characters" && (
            <div style={{ padding: "6px", display: "flex", flexDirection: "column", gap: 4 }}>
              {/* Character sub-tabs */}
              <div style={{ display: "flex", alignItems: "flex-end", borderBottom: "2px solid #808080", flexWrap: "wrap" }}>
                {characters.map((char, i) => (
                  <button key={i}
                    className={`w95-tab ${characterTab === i ? "w95-tab-active" : "w95-tab-inactive"}`}
                    style={{ padding: "2px 6px", fontSize: 10, maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    onClick={() => setCharacterTab(i)}>
                    {char.name || `Char ${i + 1}`}
                  </button>
                ))}
                <button
                  className="w95-tab w95-tab-inactive"
                  style={{ padding: "2px 6px", fontSize: 11, fontWeight: "bold", color: "#000080" }}
                  onClick={() => {
                    const m = characters[0]?.model ?? DEFAULT_MODEL;
                    setCharacters([...characters, { name: `Character ${characters.length + 1}`, systemPrompt: "", model: m, role: "character" }]);
                    setSelectedCharacterPresets([...selectedCharacterPreset, "custom"]);
                    setCharacterTab(characters.length);
                  }}>+</button>
              </div>

              {/* Character form */}
              {characters[characterTab] && (() => {
                const char = characters[characterTab];
                const preset = selectedCharacterPreset[characterTab] ?? "custom";
                const updateChar = (updates: Partial<AgentConfig>) =>
                  setCharacters((prev) => {
                    const next = [...prev];
                    next[characterTab] = { ...next[characterTab], ...updates };
                    return next;
                  });

                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <PresetRow
                      options={personalities}
                      selected={preset}
                      onSelect={(id) => handleCharPresetSelect(characterTab, id)}
                      onDelete={() => handleDeleteCharacterPreset(preset)}
                      canDelete={preset !== "custom" && !personalities.find((p) => p.id === preset)?.isBuiltIn}
                      saveName={characterPresetName || char.name}
                      onSaveName={setCharacterPresetName}
                      onSave={() => handleSaveCharacterPreset(characterTab)}
                      saving={savingCharacterPreset}
                      savePlaceholder={char.name || "Save character as..."}
                    />

                    <div className="w95-divider" />

                    <div style={{ fontSize: 10 }}>Name:</div>
                    <input className="w95-input" value={char.name}
                      onChange={(e) => updateChar({ name: e.target.value })} />

                    <div style={{ fontSize: 10 }}>Character prompt:</div>
                    <textarea className="w95-textarea" rows={10} value={char.systemPrompt}
                      placeholder="Who is this character? How do they feel? What drives them?"
                      onChange={(e) => {
                        updateChar({ systemPrompt: e.target.value });
                        if (preset !== "custom") handleCharPresetSelect(characterTab, "custom");
                      }} />

                    <div style={{ fontSize: 10 }}>
                      Primer{" "}
                      <span style={{ color: "#808080", fontWeight: "normal" }}>
                        (silent first assistant turn — primes format before they speak)
                      </span>
                    </div>
                    <input className="w95-input" value={char.primer ?? ""}
                      placeholder="Optional opening line injected as their first response..."
                      onChange={(e) => updateChar({ primer: e.target.value || undefined })} />

                    <div style={{ fontSize: 10 }}>
                      Max tokens{" "}
                      <span style={{ color: "#808080", fontWeight: "normal" }}>
                        (leave blank to use global default)
                      </span>
                    </div>
                    <input
                      className="w95-input"
                      type="number"
                      min={50} max={1000} step={10}
                      placeholder={String(numPredict)}
                      value={char.numPredict ?? ""}
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        updateChar({ numPredict: isNaN(v) ? undefined : v });
                      }}
                    />

                    {characters.length > 2 && (
                      <>
                        <div className="w95-divider" />
                        <button className="w95-btn" style={{ fontSize: 10, color: "#800000" }}
                          onClick={() => {
                            const next = characters.filter((_, j) => j !== characterTab);
                            setCharacters(next);
                            setSelectedCharacterPresets(selectedCharacterPreset.filter((_, j) => j !== characterTab));
                            setCharacterTab(Math.min(characterTab, next.length - 1));
                          }}>
                          Remove This Character
                        </button>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── Situation tab ── */}
          {setupTab === "situation" && (
            <div style={{ padding: "6px", display: "flex", flexDirection: "column", gap: 4 }}>
              <PresetRow
                options={situations}
                selected={selectedSitPreset}
                onSelect={handleSitPresetSelect}
                onDelete={() => handleDeleteSituationPreset(selectedSitPreset)}
                canDelete={selectedSitPreset !== "custom" && !situations.find((s) => s.id === selectedSitPreset)?.isBuiltIn}
                saveName={situationPresetName}
                onSaveName={setSituationPresetName}
                onSave={handleSaveSituationPreset}
                saving={savingSituationPreset}
                savePlaceholder="Save current situation as..."
              />

              <div className="w95-divider" />

              <div style={{ fontSize: 10 }}>Situation:</div>
              <textarea className="w95-textarea" rows={8}
                placeholder="Physical reality, stakes, rules of the scenario..."
                value={situation}
                onChange={(e) => {
                  setSituation(e.target.value);
                  setSelectedSitPreset("custom");
                }} />

              <div style={{ fontSize: 10 }}>
                Opening line{" "}
                <span style={{ color: "#808080", fontWeight: "normal" }}>
                  (injected as first user message before any turns)
                </span>
              </div>
              <textarea className="w95-textarea" rows={2}
                placeholder="Optional scene-setter before agents start speaking..."
                value={openingLine}
                onChange={(e) => setOpeningLine(e.target.value)} />
            </div>
          )}

          {/* ── Assembly tab ── */}
          {setupTab === "assembly" && (
            <div style={{ padding: "6px", display: "flex", flexDirection: "column", gap: 4 }}>

              {/* Character sub-tabs */}
              <div style={{ display: "flex", alignItems: "flex-end", borderBottom: "2px solid #808080", flexWrap: "wrap" }}>
                {characters.map((char, i) => (
                  <button key={i}
                    className={`w95-tab ${characterTab === i ? "w95-tab-active" : "w95-tab-inactive"}`}
                    style={{ padding: "2px 6px", fontSize: 10, maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    onClick={() => setCharacterTab(i)}>
                    {char.name || `Char ${i + 1}`}
                  </button>
                ))}
              </div>

              <div style={{ fontSize: 10, fontWeight: "bold", color: "#000080" }}>PROMPT ASSEMBLY ORDER</div>
              <div style={{ fontSize: 9, color: "#555", marginBottom: 2 }}>
                Drag blocks to reorder. Model reads top → bottom.
              </div>
              {promptBlockOrder.map((block, idx) => {
                const BLOCK_META: Record<PromptBlock, { label: string; color: string; preview: () => string }> = {
                  guidelines: {
                    label: BLOCK_LABELS.guidelines,
                    color: "#004080",
                    preview: () => {
                      const g = guidelines.trim();
                      return g ? g.slice(0, 100) + (g.length > 100 ? "…" : "") : "(empty — set in Guidelines tab)";
                    },
                  },
                  identity: {
                    label: BLOCK_LABELS.identity,
                    color: "#004000",
                    preview: () => {
                      const c = characters[characterTab];
                      if (!c) return "—";
                      const s = `You are ${c.name}.\n\n${c.systemPrompt.trim()}`;
                      return s.slice(0, 100) + (s.length > 100 ? "…" : "");
                    },
                  },
                  situation: {
                    label: BLOCK_LABELS.situation,
                    color: "#600000",
                    preview: () => {
                      const s = situation.trim();
                      return s ? s.slice(0, 100) + (s.length > 100 ? "…" : "") : "(empty — set in Situation tab)";
                    },
                  },
                };
                const meta = BLOCK_META[block];
                return (
                  <div key={block}>
                    <div
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("block-idx", String(idx))}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromIdx = parseInt(e.dataTransfer.getData("block-idx"));
                        if (fromIdx === idx) return;
                        const next = [...promptBlockOrder];
                        const [moved] = next.splice(fromIdx, 1);
                        next.splice(idx, 0, moved);
                        setPromptBlockOrder(next);
                      }}
                      style={{
                        border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080",
                        background: "#d8d8d8", padding: "4px 6px", cursor: "grab", userSelect: "none",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                        <span style={{ fontSize: 11, color: "#808080", cursor: "grab", lineHeight: 1 }}>⠿</span>
                        <span style={{ fontSize: 9, fontWeight: "bold", color: meta.color, letterSpacing: "0.5px" }}>
                          {meta.label}
                        </span>
                        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                          <button className="w95-btn" style={{ minWidth: 0, fontSize: 9, padding: "0 4px", lineHeight: "14px" }}
                            disabled={idx === 0}
                            onClick={() => {
                              const next = [...promptBlockOrder];
                              [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                              setPromptBlockOrder(next);
                            }}>▲</button>
                          <button className="w95-btn" style={{ minWidth: 0, fontSize: 9, padding: "0 4px", lineHeight: "14px" }}
                            disabled={idx === promptBlockOrder.length - 1}
                            onClick={() => {
                              const next = [...promptBlockOrder];
                              [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                              setPromptBlockOrder(next);
                            }}>▼</button>
                        </span>
                      </div>
                      <div style={{ fontSize: 9, color: "#555", fontStyle: "italic", lineHeight: 1.3 }}>
                        {meta.preview()}
                      </div>
                    </div>
                    {idx < promptBlockOrder.length - 1 && (
                      <div style={{ textAlign: "center", fontSize: 9, color: "#808080", lineHeight: "14px" }}>↓ reads next</div>
                    )}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 3, alignItems: "center", marginTop: 2 }}>
                <button className="w95-btn" style={{ fontSize: 9, padding: "1px 5px" }}
                  onClick={() => setPromptBlockOrder([...DEFAULT_BLOCK_ORDER])}>Reset</button>
              </div>

              {(() => {
                const c = characters[characterTab];
                if (!c) return null;
                const compiled = buildSystemPrompt(c, situation, guidelines, promptBlockOrder, characters);
                return (
                  <div style={{ marginTop: 2 }}>
                    <div style={{ fontSize: 9, fontWeight: "bold", color: "#555", marginBottom: 2 }}>
                      COMPILED SYSTEM PROMPT ({compiled.length} chars):
                    </div>
                    <div className="w95-deep-inset" style={{
                      fontSize: 9, color: "#000", background: "#ffffff", padding: "4px 5px",
                      maxHeight: 160, overflowY: "auto", whiteSpace: "pre-wrap", lineHeight: 1.4, fontFamily: "monospace",
                    }}>
                      {compiled || "(empty — fill in Guidelines, Characters, and Situation)"}
                    </div>
                  </div>
                );
              })()}

            </div>
          )}

        </div>
      </div>

      {/* ── Modals ── */}

      {activeModal === "runs" && (
        <PastRunsModal
          runs={pastRuns}
          onView={handleViewRun}
          onDelete={handleDeleteRun}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "run-viewer" && viewingRun && (
        <RunViewerModal run={viewingRun} onClose={() => { setViewingRun(null); setActiveModal("runs"); }} />
      )}
    </div>
  );
}
