"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ColonyAgent, ColonyMessage, VoteRecord, GamePhase } from "@/lib/colony/types";
import { generateInitialAgents, pickUniqueName, pickTrait, pickColor } from "@/lib/colony/pools";
import { streamChatResponse } from "@/lib/streamChat";
import { cleanOutput } from "@/lib/cleanOutput";
import type { ChatRequest } from "@/lib/types";
import { W95Slider } from "@/components/W95Slider";

const VOTE_INTERVAL = 15;
const MESSAGE_WINDOW = 20;
const DEFAULT_TICK_DELAY = 1500;
const DEFAULT_AGENT_COUNT = 8;
const DEFAULT_TEMPERATURE = 0.85;
const VOTE_DELAY = 1500; // ms between vote calls to avoid rate limits
const FINALIST_COUNT = 2;

const MODEL_KEY = "colony-model";
const TEMP_KEY = "colony-temperature";

// ── helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let msgId = 0;
function nextMsgId() {
  return `cm-${++msgId}`;
}

function makeAgent(name: string, trait: string, index: number, turn: number): ColonyAgent {
  return {
    id: crypto.randomUUID(),
    name,
    trait,
    alive: true,
    joinedAt: turn,
    color: pickColor(index),
  };
}

function buildColonyPrompt(agent: ColonyAgent, aliveNames: string[], voteInterval: number): string {
  const others = aliveNames.filter((n) => n !== agent.name).join(", ");
  return [
    `You are ${agent.name}. ${agent.trait}.`,
    `You're in a group chat with ${others}.`,
    `Every ${voteInterval} messages, the group votes someone out — whoever gets the most votes is eliminated and replaced by a stranger.`,
    `Speak naturally — be yourself. One or two sentences max.`,
  ].join(" ");
}

function buildNominationPrompt(agent: ColonyAgent, aliveNames: string[]): string {
  const others = aliveNames.filter((n) => n !== agent.name).join(", ");
  return `You are ${agent.name}. ${agent.trait}. The group is: ${others}. Nominate one person to face elimination. Reply with ONLY their name, nothing else.`;
}

function buildDefensePrompt(agent: ColonyAgent, aliveNames: string[]): string {
  const others = aliveNames.filter((n) => n !== agent.name).join(", ");
  return [
    `You are ${agent.name}. ${agent.trait}.`,
    `You've just been nominated for elimination by the group. The others are: ${others}.`,
    `This is your chance to make your case — why should you stay? Speak from the heart. Your survival depends on it.`,
    `Two or three sentences. No actions, no stage directions.`,
  ].join(" ");
}

function buildFinalVotePrompt(agent: ColonyAgent, aliveNames: string[], nomineeName: string, defenseText: string): string {
  const others = aliveNames.filter((n) => n !== agent.name).join(", ");
  return [
    `You are ${agent.name}. ${agent.trait}. The group is: ${others}.`,
    `The group nominated ${nomineeName} for elimination.`,
    `${nomineeName} just said in their defense: "${defenseText}"`,
    `Vote YES to eliminate ${nomineeName}, or NO to spare them. Reply with ONLY "YES" or "NO".`,
  ].join(" ");
}

function buildJurySpeechPrompt(agent: ColonyAgent, juryNames: string[], opponentName: string): string {
  return [
    `You are ${agent.name}. ${agent.trait}.`,
    `You've made it to the final two. Your opponent is ${opponentName}.`,
    `The jury — ${juryNames.join(", ")} — will now vote for the winner.`,
    `Make your case: why do you deserve to win? What did you do to earn it?`,
    `Two or three sentences. Speak from the heart.`,
  ].join(" ");
}

function buildJuryVotePrompt(juror: ColonyAgent, finalistA: string, speechA: string, finalistB: string, speechB: string): string {
  return [
    `You are ${juror.name}. ${juror.trait}. You were eliminated from the group earlier.`,
    `The final two are ${finalistA} and ${finalistB}.`,
    `${finalistA} said: "${speechA}"`,
    `${finalistB} said: "${speechB}"`,
    `Vote for the person you think deserves to win. Reply with ONLY their name, nothing else.`,
  ].join(" ");
}

function parseYesNo(response: string): "YES" | "NO" | null {
  const cleaned = response.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (cleaned.startsWith("YES")) return "YES";
  if (cleaned.startsWith("NO")) return "NO";
  return null;
}

function formatRecentChat(messages: ColonyMessage[], window: number): string {
  const recent = messages
    .filter((m) => m.type === "chat")
    .slice(-window);
  if (recent.length === 0) return "(The chat just started. Say something to break the ice.)";
  return recent.map((m) => `${m.agentName}: ${m.content}`).join("\n");
}

function parseVote(response: string, candidates: string[]): string | null {
  const cleaned = response.trim().replace(/[.!?,'"]/g, "");
  // Exact match
  const exact = candidates.find((n) => n.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;
  // Substring match
  const partial = candidates.find((n) => cleaned.toLowerCase().includes(n.toLowerCase()));
  return partial ?? null;
}

// ── main component ─────────────────────────────────────────────────────────────

export default function ColonyPage() {
  // ── state ──
  const [agents, setAgents] = useState<ColonyAgent[]>([]);
  const [messages, setMessages] = useState<ColonyMessage[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const [voteCycle, setVoteCycle] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [tickDelay, setTickDelay] = useState(DEFAULT_TICK_DELAY);
  const [agentCount, setAgentCount] = useState(DEFAULT_AGENT_COUNT);
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
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [phase, setPhase] = useState<GamePhase>("chat");

  // ── refs (avoid stale closures in async loop) ──
  const stopFlagRef = useRef(false);
  const agentsRef = useRef<ColonyAgent[]>([]);
  const messagesRef = useRef<ColonyMessage[]>([]);
  const turnCountRef = useRef(0);
  const voteCycleRef = useRef(0);
  const tickDelayRef = useRef(DEFAULT_TICK_DELAY);
  const modelRef = useRef("");
  const temperatureRef = useRef(DEFAULT_TEMPERATURE);
  const phaseRef = useRef<GamePhase>("chat");
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // ── sync refs with state ──
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { turnCountRef.current = turnCount; }, [turnCount]);
  useEffect(() => { voteCycleRef.current = voteCycle; }, [voteCycle]);
  useEffect(() => { tickDelayRef.current = tickDelay; }, [tickDelay]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { temperatureRef.current = temperature; }, [temperature]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

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

  // ── helpers ──

  const addMessage = useCallback((msg: Omit<ColonyMessage, "id">) => {
    const full = { ...msg, id: nextMsgId() };
    setMessages((prev) => [...prev, full]);
    messagesRef.current = [...messagesRef.current, full];
    return full.id;
  }, []);

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m)),
    );
    messagesRef.current = messagesRef.current.map((m) =>
      m.id === id ? { ...m, content } : m,
    );
  }, []);

  // ── tick: one agent speaks ──

  const runAgentTick = useCallback(async (speaker: ColonyAgent, turn: number) => {
    const alive = agentsRef.current.filter((a) => a.alive);
    const aliveNames = alive.map((a) => a.name);
    const system = buildColonyPrompt(speaker, aliveNames, VOTE_INTERVAL);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW);

    const request: ChatRequest = {
      model: modelRef.current,
      system,
      messages: [{ role: "user", content: recentChat }],
      temperature: temperatureRef.current,
      numPredict: 150,
    };

    // Add a streaming placeholder
    const placeholderId = addMessage({
      type: "chat",
      agentId: speaker.id,
      agentName: speaker.name,
      content: "",
      turn,
    });
    setStreamingMsgId(placeholderId);

    let streamedSoFar = "";
    let fullText = "";
    try {
      fullText = await streamChatResponse(request, (token) => {
        streamedSoFar += token;
        updateMessage(placeholderId, streamedSoFar);
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMessage(placeholderId, `[error: ${errMsg}]`);
      setStreamingMsgId(null);
      return;
    }

    // Clean and finalize
    const cleaned = cleanOutput(fullText, speaker.name, aliveNames);
    updateMessage(placeholderId, cleaned);
    setStreamingMsgId(null);
  }, [addMessage, updateMessage]);

  // ── tribal council (nomination → defense → vote) ──

  const runNominationRound = useCallback(async (): Promise<VoteRecord[]> => {
    const alive = agentsRef.current.filter((a) => a.alive);
    const aliveNames = alive.map((a) => a.name);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW);
    const votes: VoteRecord[] = [];

    for (const voter of alive) {
      if (stopFlagRef.current) return votes;

      const system = buildNominationPrompt(voter, aliveNames);
      const request: ChatRequest = {
        model: modelRef.current,
        system,
        messages: [{ role: "user", content: recentChat }],
        temperature: 0.3,
        numPredict: 20,
      };

      let response = "";
      try {
        response = await streamChatResponse(request, () => {}, undefined);
      } catch {
        response = "";
      }

      const target = parseVote(response, aliveNames.filter((n) => n !== voter.name));
      if (target) {
        votes.push({ voterId: voter.id, voterName: voter.name, targetName: target, type: "nomination" });
      }

      await sleep(VOTE_DELAY);
    }

    return votes;
  }, []);

  const runDefenseSpeech = useCallback(async (nominee: ColonyAgent): Promise<string> => {
    const alive = agentsRef.current.filter((a) => a.alive);
    const aliveNames = alive.map((a) => a.name);
    const system = buildDefensePrompt(nominee, aliveNames);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW);

    const request: ChatRequest = {
      model: modelRef.current,
      system,
      messages: [{ role: "user", content: recentChat }],
      temperature: temperatureRef.current,
      numPredict: 200,
    };

    const placeholderId = addMessage({
      type: "defense",
      agentId: nominee.id,
      agentName: nominee.name,
      content: "",
      turn: turnCountRef.current,
    });
    setStreamingMsgId(placeholderId);

    let streamedSoFar = "";
    let fullText = "";
    try {
      fullText = await streamChatResponse(request, (token) => {
        streamedSoFar += token;
        updateMessage(placeholderId, streamedSoFar);
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMessage(placeholderId, `[error: ${errMsg}]`);
      setStreamingMsgId(null);
      return "";
    }

    const cleaned = cleanOutput(fullText, nominee.name, aliveNames);
    updateMessage(placeholderId, cleaned);
    setStreamingMsgId(null);
    return cleaned;
  }, [addMessage, updateMessage]);

  const runFinalVote = useCallback(async (nominee: ColonyAgent, defenseText: string): Promise<{ eliminate: boolean; yesCount: number; noCount: number }> => {
    const alive = agentsRef.current.filter((a) => a.alive);
    const aliveNames = alive.map((a) => a.name);
    const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW);
    const voters = alive.filter((a) => a.id !== nominee.id);
    let yesCount = 0;
    let noCount = 0;
    const voteDetails: string[] = [];

    for (const voter of voters) {
      if (stopFlagRef.current) return { eliminate: false, yesCount, noCount };

      const system = buildFinalVotePrompt(voter, aliveNames, nominee.name, defenseText);
      const request: ChatRequest = {
        model: modelRef.current,
        system,
        messages: [{ role: "user", content: recentChat }],
        temperature: 0.3,
        numPredict: 10,
      };

      let response = "";
      try {
        response = await streamChatResponse(request, () => {}, undefined);
      } catch {
        response = "";
      }

      const vote = parseYesNo(response);
      if (vote === "YES") {
        yesCount++;
        voteDetails.push(`${voter.name}: YES`);
      } else {
        noCount++;
        voteDetails.push(`${voter.name}: NO`);
      }

      await sleep(VOTE_DELAY);
    }

    addMessage({
      type: "vote_result",
      agentName: "System",
      content: `*** VOTES: ${voteDetails.join(", ")} ***`,
      turn: turnCountRef.current,
    });

    return { eliminate: yesCount > noCount, yesCount, noCount };
  }, [addMessage]);

  const runTribalCouncil = useCallback(async () => {
    setPhase("tribal_council");
    setStatusMsg("Tribal Council...");

    addMessage({
      type: "vote_result",
      agentName: "System",
      content: "*** TRIBAL COUNCIL ***",
      turn: turnCountRef.current,
    });

    // 1. Nomination round
    setStatusMsg("Nominations...");
    const nominations = await runNominationRound();
    if (stopFlagRef.current) { setPhase("chat"); return; }

    // Tally nominations
    const tally = new Map<string, number>();
    for (const v of nominations) {
      tally.set(v.targetName, (tally.get(v.targetName) ?? 0) + 1);
    }

    if (tally.size === 0) {
      addMessage({ type: "system", agentName: "System", content: "*** No valid nominations. Council adjourned. ***", turn: turnCountRef.current });
      setVoteCycle((c) => c + 1);
      voteCycleRef.current += 1;
      setPhase("chat");
      return;
    }

    // Sort by vote count descending
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const nomLines = nominations.map((v) => `${v.voterName} → ${v.targetName}`).join(", ");
    addMessage({
      type: "nomination_result",
      agentName: "System",
      content: `*** NOMINATIONS: ${nomLines} ***`,
      turn: turnCountRef.current,
    });

    // Try top nominee, then runner-up if spared
    const candidates = sorted.map(([name, count]) => ({ name, count }));
    let eliminated = false;

    for (let i = 0; i < Math.min(2, candidates.length); i++) {
      if (stopFlagRef.current) { setPhase("chat"); return; }

      const candidateName = candidates[i].name;
      const candidateAgent = agentsRef.current.find((a) => a.name === candidateName && a.alive);
      if (!candidateAgent) continue;

      addMessage({
        type: "vote_result",
        agentName: "System",
        content: `*** ${candidateName} has been nominated (${candidates[i].count} vote${candidates[i].count > 1 ? "s" : ""}). Make your case. ***`,
        turn: turnCountRef.current,
      });

      // 2. Defense speech
      setStatusMsg(`${candidateName} is defending...`);
      const defenseText = await runDefenseSpeech(candidateAgent);
      if (stopFlagRef.current) { setPhase("chat"); return; }

      // 3. Final YES/NO vote
      setStatusMsg("Voting on fate...");
      const result = await runFinalVote(candidateAgent, defenseText);
      if (stopFlagRef.current) { setPhase("chat"); return; }

      if (result.eliminate) {
        // Eliminated
        const updatedAgents = agentsRef.current.map((a) =>
          a.name === candidateName ? { ...a, alive: false, eliminatedAt: turnCountRef.current } : a,
        );

        addMessage({
          type: "vote_result",
          agentName: "System",
          content: `*** ${candidateName} has been eliminated (${result.yesCount}-${result.noCount}) ***`,
          turn: turnCountRef.current,
        });

        // Check if we should spawn a replacement or enter endgame
        const aliveAfter = updatedAgents.filter((a) => a.alive).length;
        if (aliveAfter > FINALIST_COUNT) {
          // Spawn replacement
          const usedNames = updatedAgents.map((a) => a.name);
          const newName = pickUniqueName(usedNames);
          const newTrait = pickTrait();
          const newIndex = updatedAgents.length;
          const newAgent = makeAgent(newName, newTrait, newIndex, turnCountRef.current);
          updatedAgents.push(newAgent);

          addMessage({
            type: "system",
            agentName: "System",
            content: `*** ${newName} has joined the chat ***`,
            turn: turnCountRef.current,
          });
          setPhase("chat");
        } else {
          // Endgame threshold reached
          addMessage({
            type: "system",
            agentName: "System",
            content: "*** No replacement enters. The end draws near. ***",
            turn: turnCountRef.current,
          });
          setPhase("endgame");
        }

        setAgents(updatedAgents);
        agentsRef.current = updatedAgents;
        eliminated = true;
        break;
      } else {
        // Spared
        addMessage({
          type: "vote_result",
          agentName: "System",
          content: `*** ${candidateName} has been spared! (${result.yesCount}-${result.noCount}) ***`,
          turn: turnCountRef.current,
        });

        if (i === 0 && candidates.length > 1) {
          addMessage({
            type: "system",
            agentName: "System",
            content: `*** The runner-up will now face the council... ***`,
            turn: turnCountRef.current,
          });
        }
      }
    }

    if (!eliminated) {
      addMessage({
        type: "system",
        agentName: "System",
        content: "*** Council adjourned — no one was eliminated. ***",
        turn: turnCountRef.current,
      });
      setPhase("chat");
    }

    setVoteCycle((c) => c + 1);
    voteCycleRef.current += 1;
  }, [addMessage, runNominationRound, runDefenseSpeech, runFinalVote]);

  // ── endgame: final tribal council ──

  const runEndgame = useCallback(async () => {
    setPhase("endgame");
    setStatusMsg("Final Tribal Council...");

    const finalists = agentsRef.current.filter((a) => a.alive);
    const jury = agentsRef.current.filter((a) => !a.alive);

    addMessage({
      type: "vote_result",
      agentName: "System",
      content: "*** FINAL TRIBAL COUNCIL ***",
      turn: turnCountRef.current,
    });

    const juryNames = jury.map((a) => a.name);
    addMessage({
      type: "system",
      agentName: "System",
      content: `*** Jury: ${juryNames.join(", ")} ***`,
      turn: turnCountRef.current,
    });

    addMessage({
      type: "system",
      agentName: "System",
      content: `*** Finalists: ${finalists.map((a) => a.name).join(" vs ")} — make your case to the jury. ***`,
      turn: turnCountRef.current,
    });

    // Each finalist makes a speech
    const speeches = new Map<string, string>();
    for (const finalist of finalists) {
      if (stopFlagRef.current) return;

      const opponent = finalists.find((f) => f.id !== finalist.id)!;
      const system = buildJurySpeechPrompt(finalist, juryNames, opponent.name);
      const recentChat = formatRecentChat(messagesRef.current, MESSAGE_WINDOW);

      const request: ChatRequest = {
        model: modelRef.current,
        system,
        messages: [{ role: "user", content: recentChat }],
        temperature: temperatureRef.current,
        numPredict: 250,
      };

      const placeholderId = addMessage({
        type: "defense",
        agentId: finalist.id,
        agentName: finalist.name,
        content: "",
        turn: turnCountRef.current,
      });
      setStreamingMsgId(placeholderId);

      let streamedSoFar = "";
      let fullText = "";
      try {
        fullText = await streamChatResponse(request, (token) => {
          streamedSoFar += token;
          updateMessage(placeholderId, streamedSoFar);
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        updateMessage(placeholderId, `[error: ${errMsg}]`);
        setStreamingMsgId(null);
        continue;
      }

      const alive = agentsRef.current.filter((a) => a.alive);
      const cleaned = cleanOutput(fullText, finalist.name, alive.map((a) => a.name));
      updateMessage(placeholderId, cleaned);
      setStreamingMsgId(null);
      speeches.set(finalist.name, cleaned);

      await sleep(VOTE_DELAY);
    }

    if (stopFlagRef.current) return;

    // Jury votes
    addMessage({
      type: "vote_result",
      agentName: "System",
      content: "*** The jury will now vote for the winner. ***",
      turn: turnCountRef.current,
    });

    setStatusMsg("Jury voting...");
    const juryVotes: string[] = [];
    const voteDetails: string[] = [];

    for (const juror of jury) {
      if (stopFlagRef.current) return;

      const [fA, fB] = finalists;
      const system = buildJuryVotePrompt(
        juror,
        fA.name, speeches.get(fA.name) ?? "",
        fB.name, speeches.get(fB.name) ?? "",
      );
      const request: ChatRequest = {
        model: modelRef.current,
        system,
        messages: [{ role: "user", content: "Vote now." }],
        temperature: 0.5,
        numPredict: 20,
      };

      let response = "";
      try {
        response = await streamChatResponse(request, () => {}, undefined);
      } catch {
        response = "";
      }

      const target = parseVote(response, finalists.map((f) => f.name));
      if (target) {
        juryVotes.push(target);
        voteDetails.push(`${juror.name} → ${target}`);
      }

      await sleep(VOTE_DELAY);
    }

    addMessage({
      type: "vote_result",
      agentName: "System",
      content: `*** JURY VOTES: ${voteDetails.join(", ")} ***`,
      turn: turnCountRef.current,
    });

    // Tally jury votes
    const juryTally = new Map<string, number>();
    for (const v of juryVotes) {
      juryTally.set(v, (juryTally.get(v) ?? 0) + 1);
    }

    const sorted = [...juryTally.entries()].sort((a, b) => b[1] - a[1]);
    const winner = sorted[0]?.[0] ?? finalists[0].name;
    const winnerVotes = sorted[0]?.[1] ?? 0;

    addMessage({
      type: "vote_result",
      agentName: "System",
      content: `*** ${winner} WINS COLONY! (${winnerVotes} jury vote${winnerVotes !== 1 ? "s" : ""}) ***`,
      turn: turnCountRef.current,
    });

    setPhase("finished");
    setStatusMsg(`${winner} wins!`);
    setIsRunning(false);
  }, [addMessage, updateMessage]);

  // ── main loop ──

  const runLoop = useCallback(async () => {
    while (!stopFlagRef.current) {
      // Check for endgame
      if (phaseRef.current === "endgame") {
        await runEndgame();
        return;
      }

      const alive = agentsRef.current.filter((a) => a.alive);
      if (alive.length < 2) break;

      const turn = turnCountRef.current;

      // Vote check (before speaking, so agents react to the vote aftermath)
      if (turn > 0 && turn % VOTE_INTERVAL === 0) {
        await runTribalCouncil();
        if (stopFlagRef.current) break;
        // Check if endgame was triggered by the council
        if ((phaseRef.current as GamePhase) === "endgame") continue;
      }

      const speakerIndex = turn % alive.length;
      const speaker = alive[speakerIndex];
      setStatusMsg(`${speaker.name} is speaking...`);

      await runAgentTick(speaker, turn);
      if (stopFlagRef.current) break;

      setTurnCount((c) => c + 1);
      turnCountRef.current += 1;

      await sleep(tickDelayRef.current);
    }

    if (phaseRef.current !== "finished") {
      setIsRunning(false);
      setStatusMsg("Stopped");
    }
  }, [runAgentTick, runTribalCouncil, runEndgame]);

  // ── controls ──

  const handleStart = useCallback(() => {
    if (isRunning) return;
    if (!model) {
      setStatusMsg("Select a model first");
      return;
    }

    // Generate agents
    const initial = generateInitialAgents(agentCount);
    const colonyAgents = initial.map((a, i) => makeAgent(a.name, a.trait, i, 0));
    setAgents(colonyAgents);
    agentsRef.current = colonyAgents;

    // Reset state
    setMessages([]);
    messagesRef.current = [];
    setTurnCount(0);
    turnCountRef.current = 0;
    setVoteCycle(0);
    voteCycleRef.current = 0;
    stopFlagRef.current = false;
    setPhase("chat");
    phaseRef.current = "chat";
    setIsRunning(true);
    setStatusMsg("Running...");

    // Welcome message
    const names = colonyAgents.map((a) => a.name).join(", ");
    const welcomeMsg: ColonyMessage = {
      id: nextMsgId(),
      type: "system",
      agentName: "System",
      content: `*** Colony started — ${names} have entered the chat ***`,
      turn: 0,
    };
    setMessages([welcomeMsg]);
    messagesRef.current = [welcomeMsg];

    // Start loop on next tick
    setTimeout(() => runLoop(), 100);
  }, [isRunning, model, agentCount, runLoop]);

  const handleStop = useCallback(() => {
    stopFlagRef.current = true;
    setStatusMsg("Stopping...");
  }, []);

  // ── derived ──
  const aliveCount = agents.filter((a) => a.alive).length;

  // ── render ────────────────────────────────────────────────────────────────────

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
              <div className="aol-msg aol-msg-system">*** Welcome to Colony ***</div>
              <div className="aol-msg aol-msg-system">*** Configure settings on the right, then click Start ***</div>
            </>
          )}
          {messages.map((msg) => {
            if (msg.type === "system") {
              return (
                <div key={msg.id} className="aol-msg aol-msg-system">{msg.content}</div>
              );
            }
            if (msg.type === "vote_result") {
              return (
                <div key={msg.id} className="aol-msg aol-msg-vote">{msg.content}</div>
              );
            }
            if (msg.type === "nomination_result") {
              return (
                <div key={msg.id} className="aol-msg aol-msg-nomination">{msg.content}</div>
              );
            }
            if (msg.type === "defense") {
              const agent = agents.find((a) => a.id === msg.agentId);
              const color = agent?.color ?? "#000000";
              return (
                <div key={msg.id} className="aol-msg aol-msg-defense">
                  <span className="aol-name" style={{ color }}>{msg.agentName}: </span>
                  {msg.content}
                  {streamingMsgId === msg.id && <span className="aol-cursor" />}
                </div>
              );
            }
            // Chat message
            const agent = agents.find((a) => a.id === msg.agentId);
            const color = agent?.color ?? "#000000";
            return (
              <div key={msg.id} className="aol-msg" style={{ background: "#f8f8f8" }}>
                <span className="aol-name" style={{ color }}>{msg.agentName}: </span>
                {msg.content}
                {streamingMsgId === msg.id && <span className="aol-cursor" />}
              </div>
            );
          })}
          <div style={{ height: 1 }} />
        </div>

        {/* Right sidebar */}
        <div style={{
          width: 210, flexShrink: 0, display: "flex", flexDirection: "column",
          borderLeft: "2px solid #808080", overflowY: "auto", background: "#c0c0c0",
        }}>

          {/* People Here */}
          <div style={{ margin: "6px 6px 4px", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080" }}>
            <div style={{
              background: "#000080", color: "#ffffff", fontSize: 10, fontWeight: "bold",
              padding: "2px 5px", display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>{phase === "endgame" || phase === "finished" ? "Finalists" : "People Here"}</span>
              <span style={{ fontSize: 9, fontWeight: "normal" }}>{aliveCount} online</span>
            </div>
            <div className="w95-scrollable" style={{ background: "#ffffff", borderTop: "1px solid #808080", maxHeight: 250, overflowY: "auto" }}>
              {agents.filter((a) => a.alive).map((agent) => (
                <div key={agent.id} style={{ display: "flex", alignItems: "center", padding: "2px 5px", gap: 5 }}>
                  <span style={{ color: agent.color, fontSize: 9, lineHeight: 1 }}>●</span>
                  <span style={{ fontSize: 11, fontWeight: "bold" }}>{agent.name}</span>
                  <span style={{ fontSize: 9, color: "#888", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {agent.trait.length > 30 ? agent.trait.slice(0, 30) + "..." : agent.trait}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Jury / Eliminated */}
          {agents.some((a) => !a.alive) && (
            <div style={{ margin: "0 6px 4px", border: "2px solid", borderColor: "#808080 #ffffff #ffffff #808080" }}>
              <div style={{
                background: phase === "endgame" || phase === "finished" ? "#800000" : "#808080",
                color: "#ffffff", fontSize: 10, fontWeight: "bold",
                padding: "2px 5px",
              }}>
                {phase === "endgame" || phase === "finished" ? "Jury" : "Eliminated"}
              </div>
              <div className="w95-scrollable" style={{ background: "#ffffff", borderTop: "1px solid #808080", maxHeight: 150, overflowY: "auto" }}>
                {agents.filter((a) => !a.alive)
                  .slice(phase === "endgame" || phase === "finished" ? 0 : -3)
                  .map((agent) => (
                  <div key={agent.id} className="colony-eliminated" style={{ display: "flex", alignItems: "center", padding: "2px 5px", gap: 5 }}>
                    <span style={{ color: "#aaa", fontSize: 9, lineHeight: 1 }}>●</span>
                    <span style={{ fontSize: 11, color: "#999" }}>{agent.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="w95-divider" style={{ margin: "0 6px" }} />

          {/* Controls */}
          <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 3 }}>
              <button className="w95-btn w95-btn-primary" onClick={handleStart} disabled={isRunning} style={{ flex: 1 }}>
                ▶ Start
              </button>
              <button className="w95-btn" onClick={handleStop} disabled={!isRunning} style={{ flex: 1 }}>
                ■ Stop
              </button>
            </div>

            <div>
              <div style={{ fontSize: 9, color: "#555", fontWeight: "bold", marginBottom: 2 }}>AGENTS</div>
              <select
                className="w95-select"
                style={{ width: "100%" }}
                value={agentCount}
                onChange={(e) => setAgentCount(parseInt(e.target.value))}
                disabled={isRunning}
              >
                {[6, 7, 8, 9, 10, 11, 12].map((n) => (
                  <option key={n} value={n}>{n} agents</option>
                ))}
              </select>
            </div>

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

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>SPEED</span>
                <span className="w95-trackbar-value">{(tickDelay / 1000).toFixed(1)}s</span>
              </div>
              <W95Slider min={500} max={5000} step={100} value={tickDelay} onChange={setTickDelay} />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#555", fontWeight: "bold" }}>TEMP</span>
                <span className="w95-trackbar-value">{temperature.toFixed(2)}</span>
              </div>
              <W95Slider min={0} max={2} step={0.05} value={temperature} onChange={setTemperature} />
            </div>

            <div>
              <div style={{ fontSize: 9, color: "#555", fontWeight: "bold", marginBottom: 2 }}>VOTE EVERY</div>
              <div style={{ fontSize: 11, color: "#000080" }}>{VOTE_INTERVAL} turns</div>
            </div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="w95-statusbar">
        <span className="w95-status-pane">
          {phase === "finished" ? "Game Over" : phase === "endgame" ? "Final Council" : `Turn: ${turnCount}`}
        </span>
        <span className="w95-status-pane">Cycle: {voteCycle}</span>
        <span className="w95-status-pane">Alive: {aliveCount}/{agents.length || agentCount}</span>
        <span className="w95-status-pane" style={{ flex: 1 }}>{statusMsg}</span>
      </div>
    </div>
  );
}
