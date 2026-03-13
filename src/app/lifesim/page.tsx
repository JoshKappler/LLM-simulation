"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { LifeSimAgent, SimEvent, ToolAction, AgentTurnResult, LifeSimRunRecord } from "@/lib/lifesim/types";
import { generateAgents } from "@/lib/lifesim/pools";
import { LOCATIONS, HOUSE_IDS, TILE_SIZE, MAP_COLS, MAP_ROWS, getLocationName } from "@/lib/lifesim/map";
import { resolveTool, resetTurnTracking, type ToolResult } from "@/lib/lifesim/tools";
import { buildAgentSystemPrompt, buildDecisionPrompt } from "@/lib/lifesim/prompts";
import { getRoutineAction, detectDecisionPoint, describeRoutine, type DecisionContext } from "@/lib/lifesim/schedule";
import LifeSimCanvas from "@/components/LifeSimCanvas";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_AGENT_COUNT = 6;
const MAX_AGENTS = 12;
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_TEMP = 0.85;
const DEFAULT_SPEED = 2000; // ms between agent turns
const MAX_MEMORY = 15;
const MAX_ACTIONS_PER_TURN = 3;

const ACTION_EMOJIS: Record<string, string> = {
  attack: "⚔️", death: "💀", give: "🎁", steal: "🤚", steal_fail: "❌",
  work: "🔨", buy: "🛒", sell: "💰", rest: "💤", propose: "💍",
  propose_accepted: "💒", propose_rejected: "💔",
  eat: "🍞", trade: "🤝", trade_reject: "🚫", starving: "💀",
};

// ── Helper: assign spawn position for an agent at a location ──────────────
function getSpawnPos(agent: LifeSimAgent, allAgents: LifeSimAgent[]) {
  const loc = LOCATIONS.find(l => l.id === agent.location);
  if (!loc) return { x: 0, y: 0 };

  const agentsAtLoc = allAgents.filter(a => a.alive && a.location === agent.location);
  const idx = agentsAtLoc.findIndex(a => a.id === agent.id);
  const offset = loc.spawnOffsets[idx % loc.spawnOffsets.length] ?? { dx: 0, dy: 0 };

  return {
    x: loc.x * TILE_SIZE + TILE_SIZE / 2 + offset.dx,
    y: loc.y * TILE_SIZE + TILE_SIZE / 2 + offset.dy,
  };
}

// ── Parse JSON response from LLM ──────────────────────────────────────────
function parseAgentResponse(raw: string): AgentTurnResult {
  // Attempt 1: Extract JSON from the response
  try {
    let jsonStr = raw.trim();

    // Strip markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    // Find the outermost JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    // Fix common JSON issues: trailing commas, single quotes
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");

    const parsed = JSON.parse(jsonStr);
    const thought = typeof parsed.thought === "string" ? parsed.thought : undefined;
    let actions: ToolAction[] = [];

    if (Array.isArray(parsed.actions)) {
      actions = parsed.actions
        .slice(0, MAX_ACTIONS_PER_TURN)
        .map((a: { tool?: string; action?: string; name?: string; args?: Record<string, unknown>; parameters?: Record<string, unknown> }) => ({
          tool: a.tool || a.action || a.name || "observe",
          args: a.args || a.parameters || {},
        }));
    }

    if (actions.length === 0) {
      actions = [{ tool: "observe", args: {} }];
    }

    return { thought, actions };
  } catch {
    // Attempt 2: Extract meaning from plain text response
    console.warn("[lifesim] JSON parse failed, extracting from text:", raw.slice(0, 200));
    return extractActionsFromText(raw);
  }
}

// Fallback: try to infer actions from a plain-text LLM response
function extractActionsFromText(raw: string): AgentTurnResult {
  const lower = raw.toLowerCase();
  const actions: ToolAction[] = [];

  // Look for dialogue — any quoted text becomes a say action
  const quoteMatch = raw.match(/[""]([^""]+)[""]/);
  if (quoteMatch) {
    actions.push({ tool: "say", args: { message: quoteMatch[1] } });
  }

  // Look for movement keywords
  const moveMatch = lower.match(/(?:move|go|head|walk|travel)\s+(?:to\s+)?(?:the\s+)?(tavern|church|market|blacksmith|farm|forest|river|village.?square|home)/);
  if (moveMatch) {
    const loc = moveMatch[1].replace(/\s+/g, "_").replace("village_square", "village_square");
    actions.push({ tool: "move_to", args: { location: loc } });
  }

  // Look for work/rest/buy keywords
  if (/\b(work|earn|craft|forge|farm|hunt|preach|perform)\b/.test(lower) && actions.length === 0) {
    actions.push({ tool: "work", args: {} });
  }
  if (/\b(rest|sleep|recover|tired)\b/.test(lower) && actions.length === 0) {
    actions.push({ tool: "rest", args: {} });
  }
  if (/\b(buy|purchase)\b/.test(lower)) {
    const itemMatch = lower.match(/(?:buy|purchase)\s+(?:some\s+|a\s+)?(bread|sword|flowers|medicine|ore|fish|wood|ale)/);
    if (itemMatch) {
      actions.push({ tool: "buy", args: { item: itemMatch[1], quantity: 1 } });
    }
  }

  // If we still found nothing, say something generic in-character rather than just observing
  if (actions.length === 0) {
    // Check if there's any usable text to turn into speech
    const cleaned = raw.replace(/[{}\[\]"]/g, "").trim();
    if (cleaned.length > 5 && cleaned.length < 200) {
      actions.push({ tool: "say", args: { message: cleaned.slice(0, 120) } });
    } else {
      actions.push({ tool: "observe", args: {} });
    }
  }

  return {
    thought: "Responded naturally.",
    actions: actions.slice(0, MAX_ACTIONS_PER_TURN),
  };
}

// ── Main component ────────────────────────────────────────────────────────

export default function LifeSimPage() {
  // ── State ──
  const [agents, setAgents] = useState<LifeSimAgent[]>([]);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [agentPositions, setAgentPositions] = useState<Record<string, { x: number; y: number; targetX: number; targetY: number }>>({});
  const [chatBubbles, setChatBubbles] = useState<{ agentId: string; text: string; x: number; y: number; opacity: number; createdAt: number }[]>([]);
  const [actionIndicators, setActionIndicators] = useState<{ x: number; y: number; emoji: string; opacity: number }[]>([]);

  // ── Pan & zoom state ──
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });

  // ── Settings (persisted to localStorage) ──
  const [agentCount, setAgentCount] = useState(DEFAULT_AGENT_COUNT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [temperature, setTemperature] = useState(DEFAULT_TEMP);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);

  // ── Canvas sizing ──
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: MAP_COLS * TILE_SIZE, h: MAP_ROWS * TILE_SIZE });

  // ── Refs for async loop ──
  const agentsRef = useRef(agents);
  const eventsRef = useRef(events);
  const stopRef = useRef(false);
  const tickRef = useRef(0);
  const speedRef = useRef(speed);
  const runIdRef = useRef("");
  const agentPositionsRef = useRef(agentPositions);

  agentsRef.current = agents;
  eventsRef.current = events;
  tickRef.current = tick;
  speedRef.current = speed;
  agentPositionsRef.current = agentPositions;

  // ── Load models ──
  useEffect(() => {
    fetch("/api/models")
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.models)) setModels(data.models.map((m: string | { id: string }) => typeof m === "string" ? m : m.id));
        else if (Array.isArray(data)) setModels(data.map((m: { id: string } | string) => typeof m === "string" ? m : m.id));
      })
      .catch(() => {});
  }, []);

  // ── Load settings from localStorage ──
  useEffect(() => {
    try {
      const saved = localStorage.getItem("lifesim_settings");
      if (saved) {
        const s = JSON.parse(saved);
        if (s.model) setModel(s.model);
        if (s.temperature) setTemperature(s.temperature);
        if (s.speed) setSpeed(s.speed);
        if (s.agentCount) setAgentCount(s.agentCount);
      }
    } catch {}
  }, []);

  // Save settings
  useEffect(() => {
    try {
      localStorage.setItem("lifesim_settings", JSON.stringify({ model, temperature, speed, agentCount }));
    } catch {}
  }, [model, temperature, speed, agentCount]);

  // ── Canvas resize observer ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      // Maintain aspect ratio
      const aspect = MAP_COLS / MAP_ROWS;
      let w = rect.width;
      let h = w / aspect;
      if (h > rect.height) {
        h = rect.height;
        w = h * aspect;
      }
      setCanvasSize({ w: Math.floor(w), h: Math.floor(h) });
    };

    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    updateSize();
    return () => observer.disconnect();
  }, []);

  // ── Fade chat bubbles and action indicators ──
  useEffect(() => {
    const interval = setInterval(() => {
      setChatBubbles(prev => {
        const now = Date.now();
        return prev
          .map(b => ({
            ...b,
            opacity: Math.max(0, 1 - (now - b.createdAt) / 4000),
          }))
          .filter(b => b.opacity > 0);
      });
      setActionIndicators(prev =>
        prev.map(a => ({ ...a, opacity: a.opacity - 0.05 })).filter(a => a.opacity > 0)
      );
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // ── Interpolate agent positions toward targets ──
  useEffect(() => {
    const interval = setInterval(() => {
      setAgentPositions(prev => {
        const next = { ...prev };
        let changed = false;
        for (const id of Object.keys(next)) {
          const p = next[id];
          const dx = p.targetX - p.x;
          const dy = p.targetY - p.y;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            next[id] = {
              ...p,
              x: p.x + dx * 0.15,
              y: p.y + dy * 0.15,
            };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 30);
    return () => clearInterval(interval);
  }, []);

  // ── Initialize agents ──
  const initializeAgents = useCallback((): LifeSimAgent[] => {
    const generated = generateAgents(agentCount);
    const newAgents: LifeSimAgent[] = generated.map((g, i) => {
      const homeId = HOUSE_IDS[i % HOUSE_IDS.length];
      const startLoc = homeId; // everyone starts at home — morning of day 1
      const startingInventory: { name: string; quantity: number }[] = [];
      let startGold = 15 + Math.floor(Math.random() * 10); // 15-24 gold

      // Production occupations start with materials
      if (g.occupation === "farmer") { startingInventory.push({ name: "wheat", quantity: 3 }); }
      else if (g.occupation === "hunter") { startingInventory.push({ name: "meat", quantity: 2 }); }
      else if (g.occupation === "miner") { startingInventory.push({ name: "ore", quantity: 2 }); }
      else if (g.occupation === "blacksmith") { startingInventory.push({ name: "ore", quantity: 3 }); }
      else { startGold += 8; } // Service occupations get more gold

      // Everyone starts with enough food for a few days
      startingInventory.push({ name: "bread", quantity: 3 });

      return {
        id: `agent_${i}_${Date.now()}`,
        name: g.name,
        personality: g.personality,
        occupation: g.occupation,
        color: g.color,
        health: 100,
        energy: 100,
        hunger: 0, // start satisfied — let scarcity develop naturally
        gold: startGold,
        alive: true,
        location: startLoc,
        home: homeId,
        spouse: null,
        inventory: startingInventory,
        relationships: {},
        memory: [],
      };
    });

    // Initialize positions
    const positions: Record<string, { x: number; y: number; targetX: number; targetY: number }> = {};
    for (const agent of newAgents) {
      const pos = getSpawnPos(agent, newAgents);
      positions[agent.id] = { x: pos.x, y: pos.y, targetX: pos.x, targetY: pos.y };
    }
    setAgentPositions(positions);
    return newAgents;
  }, [agentCount]);

  // ── Call LLM for one agent (retries on JSON validation failures) ──
  const callAgentLLM = useCallback(async (agent: LifeSimAgent, allAgents: LifeSimAgent[], currentTick: number, decision?: DecisionContext, routineAction?: ToolAction): Promise<AgentTurnResult> => {
    const systemPrompt = decision && routineAction
      ? buildDecisionPrompt(agent, allAgents, currentTick, decision, describeRoutine(routineAction))
      : buildAgentSystemPrompt(agent, allAgents, currentTick);
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch("/api/chat-tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            system: systemPrompt,
            messages: [{ role: "user", content: "What do you do?" }],
            temperature,
            maxTokens: 400,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          // Retry on JSON validation failures (Groq returns 400 when model can't produce valid JSON)
          if (res.status === 400 && err.includes("json_validate_failed") && attempt < maxAttempts - 1) {
            console.warn(`[lifesim] JSON validation failed for ${agent.name}, retrying...`);
            continue;
          }
          console.error("[lifesim] LLM error:", err);
          return { thought: "Error communicating.", actions: [{ tool: "observe", args: {} }] };
        }

        const data = await res.json();
        if (data.error) {
          console.error("[lifesim] LLM error:", data.error);
          return { thought: "Error.", actions: [{ tool: "observe", args: {} }] };
        }

        return parseAgentResponse(data.content);
      } catch (err) {
        console.error("[lifesim] fetch error:", err);
        return { thought: "Error.", actions: [{ tool: "rest", args: {} }] };
      }
    }

    return { thought: "Confused.", actions: [{ tool: "observe", args: {} }] };
  }, [model, temperature]);

  // ── Resolve a single action and propagate events, memory, visuals ──
  const resolveActionAndPropagate = useCallback((
    action: ToolAction,
    agent: LifeSimAgent,
    allAgents: LifeSimAgent[],
    currentTick: number,
  ) => {
    setStatus(`${agent.name}: ${action.tool}(${Object.values(action.args).join(", ")})`);

    const result = resolveTool(action, agent, allAgents, currentTick);
    if (!result) return;

    setEvents(prev => [...prev, result.event]);

    if (result.memoryForAgent) {
      agent.memory.push(result.memoryForAgent);
      if (agent.memory.length > MAX_MEMORY) agent.memory = agent.memory.slice(-MAX_MEMORY);
    }

    if (result.memoryForWitnesses) {
      const witnesses = allAgents.filter(a =>
        a.alive && a.id !== agent.id && a.location === result.event.location
      );
      for (const w of witnesses) {
        w.memory.push(result.memoryForWitnesses);
        if (w.memory.length > MAX_MEMORY) w.memory = w.memory.slice(-MAX_MEMORY);
      }
    }

    if (result.targetMemory) {
      const target = allAgents.find(a => a.id === result.targetMemory!.targetId);
      if (target) {
        target.memory.push(result.targetMemory.text);
        if (target.memory.length > MAX_MEMORY) target.memory = target.memory.slice(-MAX_MEMORY);
      }
    }

    if (result.memoryForAll) {
      for (const a of allAgents) {
        if (a.alive && a.id !== agent.id) {
          a.memory.push(result.memoryForAll);
          if (a.memory.length > MAX_MEMORY) a.memory = a.memory.slice(-MAX_MEMORY);
        }
      }
    }

    if (result.departureMemory) {
      const departees = allAgents.filter(a =>
        a.alive && a.id !== agent.id && a.location === result.departureMemory!.locationId
      );
      for (const d of departees) {
        d.memory.push(result.departureMemory.text);
        if (d.memory.length > MAX_MEMORY) d.memory = d.memory.slice(-MAX_MEMORY);
      }
    }

    const pos = agentPositionsRef.current[agent.id] ?? { x: 0, y: 0, targetX: 0, targetY: 0 };

    if (result.event.type === "say" && result.event.message) {
      setChatBubbles(prev => [...prev.slice(-4), {
        agentId: agent.id,
        text: result.event.message ?? "",
        x: pos.targetX || pos.x,
        y: pos.targetY || pos.y,
        opacity: 1,
        createdAt: Date.now(),
      }]);
    }

    const emoji = ACTION_EMOJIS[result.event.type];
    if (emoji) {
      setActionIndicators(prev => [...prev.slice(-4), {
        x: pos.targetX || pos.x,
        y: pos.targetY || pos.y,
        emoji,
        opacity: 1,
      }]);
    }

    if (result.event.type === "move") {
      const newPos = getSpawnPos(agent, allAgents);
      setAgentPositions(prev => ({
        ...prev,
        [agent.id]: { ...prev[agent.id], targetX: newPos.x, targetY: newPos.y },
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Process a routine turn (no LLM call — deterministic behavior) ──
  const processRoutineTurn = useCallback((
    agent: LifeSimAgent,
    allAgents: LifeSimAgent[],
    currentTick: number,
    routineAction: ToolAction,
  ) => {
    if (!agent.alive) return;
    resetTurnTracking();
    resolveActionAndPropagate(routineAction, agent, allAgents, currentTick);
    setAgents([...allAgents]);
  }, [resolveActionAndPropagate]);

  // ── Process a decision turn (LLM call — agent makes a real choice) ──
  const processDecisionTurn = useCallback(async (
    agent: LifeSimAgent,
    allAgents: LifeSimAgent[],
    currentTick: number,
    decision: DecisionContext,
    routineAction: ToolAction,
  ) => {
    if (!agent.alive) return;
    setStatus(`${agent.name} is thinking...`);
    resetTurnTracking();

    const turnResult = await callAgentLLM(agent, allAgents, currentTick, decision, routineAction);

    if (turnResult.thought) {
      const thoughtEvent: SimEvent = {
        id: `thought_${Date.now()}_${Math.random()}`,
        tick: currentTick,
        agentId: agent.id,
        agentName: agent.name,
        type: "system",
        location: agent.location,
        message: turnResult.thought,
        timestamp: Date.now(),
      };
      setEvents(prev => [...prev, thoughtEvent]);
    }

    for (const action of turnResult.actions) {
      if (!agent.alive) break;
      resolveActionAndPropagate(action, agent, allAgents, currentTick);
    }

    setAgents([...allAgents]);
  }, [callAgentLLM, resolveActionAndPropagate]);

  // ── Process one agent's turn (legacy — kept for backward compat) ──
  const processAgentTurn = useCallback(async (agent: LifeSimAgent, allAgents: LifeSimAgent[], currentTick: number) => {
    if (!agent.alive) return;

    setStatus(`${agent.name} is thinking...`);
    resetTurnTracking(); // Reset per-turn limits (e.g., 1 attack per turn)

    const turnResult = await callAgentLLM(agent, allAgents, currentTick);

    if (turnResult.thought) {
      // Add thought as a system event (visible in log)
      const thoughtEvent: SimEvent = {
        id: `thought_${Date.now()}_${Math.random()}`,
        tick: currentTick,
        agentId: agent.id,
        agentName: agent.name,
        type: "system",
        location: agent.location,
        message: turnResult.thought,
        timestamp: Date.now(),
      };
      setEvents(prev => [...prev, thoughtEvent]);
    }

    // Resolve each action
    for (const action of turnResult.actions) {
      if (!agent.alive) break; // Agent might have died

      setStatus(`${agent.name}: ${action.tool}(${Object.values(action.args).join(", ")})`);

      const result = resolveTool(action, agent, allAgents, currentTick);
      if (!result) continue;

      // Add event
      setEvents(prev => [...prev, result.event]);

      // Update agent memory
      if (result.memoryForAgent) {
        agent.memory.push(result.memoryForAgent);
        if (agent.memory.length > MAX_MEMORY) agent.memory = agent.memory.slice(-MAX_MEMORY);
      }

      // Update witness memories
      if (result.memoryForWitnesses) {
        const witnesses = allAgents.filter(a =>
          a.alive && a.id !== agent.id && a.location === result.event.location
        );
        for (const w of witnesses) {
          w.memory.push(result.memoryForWitnesses);
          if (w.memory.length > MAX_MEMORY) w.memory = w.memory.slice(-MAX_MEMORY);
        }
      }

      // Target-specific memory
      if (result.targetMemory) {
        const target = allAgents.find(a => a.id === result.targetMemory!.targetId);
        if (target) {
          target.memory.push(result.targetMemory.text);
          if (target.memory.length > MAX_MEMORY) target.memory = target.memory.slice(-MAX_MEMORY);
        }
      }

      // Global memory (e.g. death)
      if (result.memoryForAll) {
        for (const a of allAgents) {
          if (a.alive && a.id !== agent.id) {
            a.memory.push(result.memoryForAll);
            if (a.memory.length > MAX_MEMORY) a.memory = a.memory.slice(-MAX_MEMORY);
          }
        }
      }

      // Departure memory (notify agents at old location when someone leaves)
      if (result.departureMemory) {
        const departees = allAgents.filter(a =>
          a.alive && a.id !== agent.id && a.location === result.departureMemory!.locationId
        );
        for (const d of departees) {
          d.memory.push(result.departureMemory.text);
          if (d.memory.length > MAX_MEMORY) d.memory = d.memory.slice(-MAX_MEMORY);
        }
      }

      // Visual effects
      const pos = agentPositionsRef.current[agent.id] ?? { x: 0, y: 0, targetX: 0, targetY: 0 };

      // Chat bubble for say events
      if (result.event.type === "say" && result.event.message) {
        const bubble = {
          agentId: agent.id,
          text: result.event.message,
          x: pos.targetX || pos.x,
          y: pos.targetY || pos.y,
          opacity: 1,
          createdAt: Date.now(),
        };
        setChatBubbles(prev => [...prev.slice(-4), bubble]);
      }

      // Action indicator
      const emoji = ACTION_EMOJIS[result.event.type];
      if (emoji) {
        setActionIndicators(prev => [...prev.slice(-4), {
          x: pos.targetX || pos.x,
          y: pos.targetY || pos.y,
          emoji,
          opacity: 1,
        }]);
      }

      // Update position if moved
      if (result.event.type === "move") {
        const newPos = getSpawnPos(agent, allAgents);
        setAgentPositions(prev => ({
          ...prev,
          [agent.id]: { ...prev[agent.id], targetX: newPos.x, targetY: newPos.y },
        }));
      }
    }

    // Update the agents state
    setAgents([...allAgents]);
  }, [callAgentLLM]);

  // ── Save run to disk ──
  const saveRun = useCallback(async (
    runId: string,
    finalAgents: LifeSimAgent[],
    initialAgents: LifeSimAgent[],
    allEvents: SimEvent[],
    finalTick: number,
  ) => {
    const record: LifeSimRunRecord = {
      id: runId,
      startedAt: new Date(parseInt(runId)).toISOString(),
      endedAt: new Date().toISOString(),
      tickCount: finalTick,
      model,
      temperature,
      agentCount: finalAgents.length,
      agents: finalAgents,
      events: allEvents,
      initialAgents,
    };

    try {
      await fetch("/api/lifesim-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch (err) {
      console.error("[lifesim] Failed to save run:", err);
    }
  }, [model, temperature]);

  // ── Main game loop ──
  const startSimulation = useCallback(async () => {
    const newAgents = initializeAgents();
    const initialSnapshot = JSON.parse(JSON.stringify(newAgents)) as LifeSimAgent[];
    setAgents(newAgents);
    setEvents([]);
    setChatBubbles([]);
    setActionIndicators([]);
    setTick(0);
    setRunning(true);
    stopRef.current = false;

    const runId = String(Date.now());
    runIdRef.current = runId;

    // System event
    const startEvent: SimEvent = {
      id: `sys_start_${Date.now()}`,
      tick: 0,
      agentId: "system",
      agentName: "System",
      type: "system",
      location: "",
      message: `Simulation started with ${newAgents.length} villagers.`,
      timestamp: Date.now(),
    };
    setEvents([startEvent]);

    agentsRef.current = newAgents;

    let currentTick = 0;
    while (!stopRef.current) {
      currentTick++;
      setTick(currentTick);

      const aliveAgents = agentsRef.current.filter(a => a.alive);
      if (aliveAgents.length <= 1) {
        setStatus(aliveAgents.length === 1 ? `${aliveAgents[0].name} is the last one standing!` : "Everyone is dead!");
        break;
      }

      // Shuffle turn order each tick for fairness
      for (let i = aliveAgents.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [aliveAgents[i], aliveAgents[j]] = [aliveAgents[j], aliveAgents[i]];
      }

      for (const agent of aliveAgents) {
        if (stopRef.current || !agent.alive) break;

        const routineAction = getRoutineAction(agent, agentsRef.current, currentTick);
        const decision = detectDecisionPoint(agent, agentsRef.current, currentTick);

        if (decision) {
          // LLM decision turn — something interesting is happening
          await processDecisionTurn(agent, agentsRef.current, currentTick, decision, routineAction);
          await new Promise(r => setTimeout(r, speedRef.current));
        } else {
          // Routine turn — deterministic, no LLM call, fast
          processRoutineTurn(agent, agentsRef.current, currentTick, routineAction);
          await new Promise(r => setTimeout(r, Math.min(400, speedRef.current / 3)));
        }
      }

      // Per-tick survival mechanics (rebalanced)
      for (const agent of agentsRef.current) {
        if (!agent.alive) continue;

        // Energy drain: slow base + penalty if outside at night
        agent.energy = Math.max(0, agent.energy - 1);
        if (currentTick % 6 === 5 && agent.location !== agent.home) {
          agent.energy = Math.max(0, agent.energy - 3); // cold night outside
        }

        // Hunger: slow growth (+3 per tick — agents eat roughly every 12 ticks)
        agent.hunger = Math.min(100, agent.hunger + 3);

        // Starvation damage: if hunger >= 90, take health damage
        if (agent.hunger >= 90) {
          const starveDmg = agent.hunger >= 95 ? 8 : 3;
          agent.health = Math.max(0, agent.health - starveDmg);

          const starveEvent: SimEvent = {
            id: `starve_${Date.now()}_${agent.id}`,
            tick: currentTick,
            agentId: agent.id,
            agentName: agent.name,
            type: "starving",
            location: agent.location,
            damage: starveDmg,
            result: `${agent.name} is starving! Lost ${starveDmg} HP. (${agent.health} HP left)`,
            timestamp: Date.now(),
          };
          setEvents(prev => [...prev, starveEvent]);
          agent.memory.push(`[Turn ${currentTick}] You are starving! Lost ${starveDmg} health. Health: ${agent.health}/100.`);
          if (agent.memory.length > MAX_MEMORY) agent.memory = agent.memory.slice(-MAX_MEMORY);

          // Death by starvation
          if (agent.health <= 0) {
            agent.alive = false;
            const deathEvent: SimEvent = {
              id: `death_starve_${Date.now()}_${agent.id}`,
              tick: currentTick,
              agentId: agent.id,
              agentName: agent.name,
              type: "death",
              location: agent.location,
              result: `${agent.name} has starved to death!`,
              timestamp: Date.now(),
            };
            setEvents(prev => [...prev, deathEvent]);
            // Notify all agents
            for (const other of agentsRef.current) {
              if (other.alive && other.id !== agent.id) {
                other.memory.push(`[Turn ${currentTick}] ${agent.name} starved to death!`);
                if (other.memory.length > MAX_MEMORY) other.memory = other.memory.slice(-MAX_MEMORY);
              }
            }
          }
        }

        // Proximity relationship building: being near others breeds familiarity
        if (agent.alive) {
          const neighbors = agentsRef.current.filter(a =>
            a.alive && a.id !== agent.id && a.location === agent.location
          );
          for (const other of neighbors) {
            const current = agent.relationships[other.id] ?? 0;
            if (current < 25) { // passive growth caps at "friendly"
              agent.relationships[other.id] = current + 1;
            }
          }
        }

        // Spouse relationship bonus
        if (agent.spouse && agent.alive) {
          const spouse = agentsRef.current.find(a => a.id === agent.spouse);
          if (spouse?.alive) {
            agent.relationships[spouse.id] = Math.min(100, (agent.relationships[spouse.id] ?? 0) + 2);
          }
        }
      }
      setAgents([...agentsRef.current]);
    }

    setRunning(false);
    setStatus("Simulation ended.");

    // Save run
    await saveRun(runId, agentsRef.current, initialSnapshot, eventsRef.current, currentTick);
  }, [initializeAgents, processDecisionTurn, processRoutineTurn, saveRun]);

  const stopSimulation = useCallback(() => {
    stopRef.current = true;
    setStatus("Stopping...");
  }, []);

  // ── Derived state ──
  const selectedAgent = agents.find(a => a.id === selectedAgentId);
  const aliveCount = agents.filter(a => a.alive).length;

  // ── Pan / zoom handlers ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setCamera(prev => {
      const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZoom = Math.min(4, Math.max(0.5, prev.zoom * zoomFactor));
      // Zoom toward mouse position
      const container = containerRef.current;
      if (!container) return { ...prev, zoom: newZoom };
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      return {
        x: mx - (mx - prev.x) * (newZoom / prev.zoom),
        y: my - (my - prev.y) * (newZoom / prev.zoom),
        zoom: newZoom,
      };
    });
  }, []);

  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, camX: 0, camY: 0 });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only pan with middle mouse or when not clicking an agent
    if (e.button === 1 || e.button === 0) {
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, camX: camera.x, camY: camera.y };
    }
  }, [camera.x, camera.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      setCamera(prev => ({
        ...prev,
        x: panStart.current.camX + dx,
        y: panStart.current.camY + dy,
      }));
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleResetView = useCallback(() => {
    setCamera({ x: 0, y: 0, zoom: 1 });
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* ── Left: Canvas ── */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#2a2a2a",
            padding: 4,
            overflow: "hidden",
          }}
          className="w95-deep-inset"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <LifeSimCanvas
            width={canvasSize.w}
            height={canvasSize.h}
            agents={agents}
            agentPositions={agentPositions}
            selectedAgentId={selectedAgentId}
            onAgentClick={setSelectedAgentId}
            chatBubbles={chatBubbles}
            actionIndicators={actionIndicators}
            camera={camera}
          />
        </div>

        {/* ── Right: Panel ── */}
        <div style={{ width: 280, display: "flex", flexDirection: "column", borderLeft: "2px solid #808080", background: "#c0c0c0", flexShrink: 0 }}>
          {/* Agent List */}
          <div className="aol-panel-header">Villagers ({aliveCount}/{agents.length})</div>
          <div className="w95-scrollable" style={{ flex: "0 0 auto", maxHeight: 160, overflowY: "auto", background: "#fff" }}>
            {agents.map(agent => (
              <div
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                className={agent.alive ? "" : "colony-eliminated"}
                style={{
                  padding: "2px 6px",
                  fontSize: 11,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: selectedAgentId === agent.id ? "#dce8ff" : "transparent",
                  borderBottom: "1px solid #eee",
                }}
              >
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: agent.color, flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{agent.name}</span>
                <span style={{ color: "#888", fontSize: 10 }}>{agent.occupation}</span>
                {agent.alive && (
                  <>
                    <span style={{ fontSize: 10, color: agent.health > 50 ? "#228833" : agent.health > 25 ? "#aa8800" : "#cc2222" }}>
                      {agent.health}hp
                    </span>
                    {agent.hunger >= 60 && (
                      <span style={{ fontSize: 9, color: agent.hunger >= 80 ? "#cc0000" : "#aa8800" }}>
                        {agent.hunger >= 80 ? "☠" : "🍽"}
                      </span>
                    )}
                  </>
                )}
                {!agent.alive && <span style={{ fontSize: 10, color: "#cc0000" }}>dead</span>}
              </div>
            ))}
          </div>

          {/* Agent Detail */}
          {selectedAgent && (
            <>
              <div className="aol-panel-header">{selectedAgent.name}</div>
              <div className="w95-scrollable" style={{ flex: "0 0 auto", maxHeight: 180, overflowY: "auto", background: "#fff", padding: 4, fontSize: 11 }}>
                <div><b>Occupation:</b> {selectedAgent.occupation}</div>
                <div><b>Personality:</b> {selectedAgent.personality}</div>
                <div style={{ marginTop: 2 }}>
                  <b>HP:</b> {selectedAgent.health} | <b>Energy:</b> {selectedAgent.energy} | <b>Gold:</b> {selectedAgent.gold}
                </div>
                <div>
                  <b>Hunger:</b>{" "}
                  <span style={{ color: selectedAgent.hunger >= 80 ? "#cc2222" : selectedAgent.hunger >= 50 ? "#aa8800" : "#228833" }}>
                    {selectedAgent.hunger}/100
                    {selectedAgent.hunger >= 80 ? " STARVING" : selectedAgent.hunger >= 50 ? " hungry" : ""}
                  </span>
                </div>
                <div><b>Location:</b> {getLocationName(selectedAgent.location)}</div>
                {selectedAgent.spouse && (
                  <div><b>Spouse:</b> {agents.find(a => a.id === selectedAgent.spouse)?.name}</div>
                )}
                {selectedAgent.inventory.length > 0 && (
                  <div><b>Inventory:</b> {selectedAgent.inventory.map(i => `${i.name}×${i.quantity}`).join(", ")}</div>
                )}
                {/* Relationships */}
                <div style={{ marginTop: 4 }}><b>Relationships:</b></div>
                {agents.filter(a => a.id !== selectedAgent.id && a.alive).map(other => {
                  const rel = selectedAgent.relationships[other.id] ?? 0;
                  const barColor = rel > 0 ? "#44aa44" : rel < 0 ? "#cc4444" : "#888";
                  return (
                    <div key={other.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                      <span style={{ width: 50, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{other.name}</span>
                      <div style={{ flex: 1, height: 6, background: "#ddd", position: "relative" }}>
                        <div style={{
                          position: "absolute",
                          left: rel >= 0 ? "50%" : `${50 + rel / 2}%`,
                          width: `${Math.abs(rel) / 2}%`,
                          height: "100%",
                          background: barColor,
                        }} />
                      </div>
                      <span style={{ width: 24, textAlign: "right", color: barColor }}>{rel}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Event Log */}
          <div className="aol-panel-header">Event Log</div>
          <div
            className="w95-scrollable"
            style={{ flex: 1, overflowY: "auto", background: "#fff", fontSize: 10 }}
            ref={el => { if (el) el.scrollTop = el.scrollHeight; }}
          >
            {events.slice(-100).map((ev) => (
              <div
                key={ev.id}
                style={{
                  padding: "1px 6px",
                  borderBottom: "1px solid #f0f0f0",
                  color: ev.type === "system" ? "#888"
                    : ev.type === "death" || ev.type === "starving" ? "#cc0000"
                    : ev.type === "attack" ? "#aa4400" : ev.type === "say" ? "#000"
                    : ev.type === "steal" || ev.type === "steal_fail" ? "#884400"
                    : ev.type === "propose_accepted" ? "#aa00aa"
                    : ev.type === "give" || ev.type === "trade" ? "#006600"
                    : ev.type === "trade_reject" ? "#884400"
                    : ev.type === "eat" ? "#336600"
                    : "#555",
                  fontStyle: ev.type === "system" ? "italic" : "normal",
                }}
              >
                <span style={{ color: "#aaa", marginRight: 4 }}>T{ev.tick}</span>
                {ev.type === "system" ? (
                  <span>{ev.agentName !== "System" && <b>{ev.agentName}: </b>}{ev.message}</span>
                ) : ev.type === "say" ? (
                  <span><b style={{ color: agents.find(a => a.id === ev.agentId)?.color }}>{ev.agentName}:</b> &ldquo;{ev.message}&rdquo;</span>
                ) : (
                  <span>{ev.result}</span>
                )}
              </div>
            ))}
          </div>

          {/* ── Controls (moved from bottom bar) ── */}
          <div className="aol-panel-header">Controls</div>
          <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                className="w95-btn w95-btn-primary"
                onClick={running ? stopSimulation : startSimulation}
                style={{ flex: 1 }}
              >
                {running ? "■ Stop" : "▶ Start"}
              </button>
              <button
                className="w95-btn"
                onClick={handleResetView}
                title="Reset map view"
                style={{ minWidth: 0, padding: "3px 6px" }}
              >
                ⌂
              </button>
            </div>

            <div className="lifesim-ctrl-row">
              <span className="lifesim-ctrl-label">Model</span>
              <select
                className="w95-select"
                value={model}
                onChange={e => setModel(e.target.value)}
                disabled={running}
                style={{ flex: 1, minWidth: 0 }}
              >
                {models.length > 0 ? models.map(m => (
                  <option key={m} value={m}>{m}</option>
                )) : (
                  <option value={model}>{model}</option>
                )}
              </select>
            </div>

            <div className="lifesim-ctrl-row">
              <span className="lifesim-ctrl-label">Speed</span>
              <input
                type="range"
                className="w95-range"
                min={200}
                max={5000}
                step={100}
                value={speed}
                onChange={e => setSpeed(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span className="w95-trackbar-value">{(speed / 1000).toFixed(1)}s</span>
            </div>

            <div className="lifesim-ctrl-row">
              <span className="lifesim-ctrl-label">Temp</span>
              <input
                type="range"
                className="w95-range"
                min={0}
                max={200}
                value={Math.round(temperature * 100)}
                onChange={e => setTemperature(Number(e.target.value) / 100)}
                style={{ flex: 1 }}
              />
              <span className="w95-trackbar-value">{temperature.toFixed(2)}</span>
            </div>

            <div className="lifesim-ctrl-row">
              <span className="lifesim-ctrl-label">Agents</span>
              <select
                className="w95-select"
                value={agentCount}
                onChange={e => setAgentCount(Number(e.target.value))}
                disabled={running}
                style={{ width: 48 }}
              >
                {Array.from({ length: MAX_AGENTS - 3 }, (_, i) => i + 4).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div className="w95-statusbar">
        <span className="w95-status-pane" style={{ flex: 1 }}>{status}</span>
        <span className="w95-status-pane">Turn: {tick}</span>
        <span className="w95-status-pane">Alive: {aliveCount}/{agents.length}</span>
      </div>
    </div>
  );
}
