import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { LifeSimRunRecord } from "@/lib/lifesim/types";

const DIR = path.join(process.cwd(), "life-sim");

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

/** Build a human-readable transcript from a run record. */
function buildTranscript(run: LifeSimRunRecord): string {
  const lines: string[] = [];

  lines.push(`LIFE SIM — ${run.startedAt}`);
  lines.push(`Model: ${run.model} | Temp: ${run.temperature} | Ticks: ${run.tickCount} | Agents: ${run.agentCount}`);
  lines.push("");

  // Agent roster
  lines.push("VILLAGERS");
  for (const a of run.initialAgents) {
    lines.push(`  ${a.name} — ${a.occupation} — "${a.personality}"`);
  }
  lines.push("");
  lines.push("─".repeat(60));
  lines.push("");

  // Events
  let lastTick = -1;
  for (const ev of run.events) {
    if (ev.tick !== lastTick) {
      if (lastTick !== -1) lines.push("");
      lines.push(`── Tick ${ev.tick} ${"─".repeat(40)}`);
      lastTick = ev.tick;
    }

    if (ev.type === "system") {
      if (ev.agentName === "System") {
        lines.push(`  [SYSTEM] ${ev.message}`);
      } else {
        lines.push(`  [${ev.agentName} thinks] ${ev.message}`);
      }
    } else if (ev.type === "say") {
      lines.push(`  ${ev.agentName}: "${ev.message}"`);
    } else if (ev.type === "death") {
      lines.push(`  *** ${ev.result} ***`);
    } else {
      lines.push(`  ${ev.agentName} > ${ev.result}`);
    }
  }

  lines.push("");
  lines.push("─".repeat(60));
  lines.push("FINAL STATE");
  for (const a of run.agents) {
    const status = a.alive ? `HP:${a.health} Gold:${a.gold}` : "DEAD";
    const spouse = a.spouse ? ` (married to ${run.agents.find(x => x.id === a.spouse)?.name ?? "?"})` : "";
    lines.push(`  ${a.name} — ${a.occupation} — ${status}${spouse}`);
  }

  return lines.join("\n");
}

export async function GET() {
  await ensureDir();
  try {
    const files = await readdir(DIR);
    const runs: LifeSimRunRecord[] = [];

    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(path.join(DIR, file), "utf-8");
        runs.push(JSON.parse(raw) as LifeSimRunRecord);
      } catch { /* skip corrupt files */ }
    }
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}

export async function POST(req: NextRequest) {
  await ensureDir();
  const run = (await req.json()) as LifeSimRunRecord;
  const jsonPath = path.join(DIR, `${run.id}.json`);
  const txtPath = path.join(DIR, `${run.id}.txt`);

  await writeFile(jsonPath, JSON.stringify(run, null, 2));
  await writeFile(txtPath, buildTranscript(run));

  return NextResponse.json({ success: true }, { status: 201 });
}
