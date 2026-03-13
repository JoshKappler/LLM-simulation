import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { MafiaRunRecord } from "@/lib/mafia/types";

const DIR = path.join(process.cwd(), "mafia-runs");

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

/** Build a human-readable transcript from a run record. */
function buildTranscript(run: MafiaRunRecord): string {
  const lines: string[] = [];

  lines.push(`MAFIA GAME — ${run.savedAt}`);
  lines.push(`Model: ${run.model} | Temp: ${run.temperature} | Rounds: ${run.roundCount}`);
  lines.push(`Winner: ${run.winner ?? "none"}`);
  lines.push("");

  // Role sheet
  lines.push("PLAYERS");
  for (const p of run.players) {
    const status = p.alive ? "alive" : "dead";
    lines.push(`  ${p.name} — ${p.role.toUpperCase()} (${status}) — ${p.personality}`);
  }
  lines.push("");
  lines.push("─".repeat(60));
  lines.push("");

  // Messages grouped by round+phase
  let lastRound = -1;
  let lastPhase = "";

  for (const m of run.messages) {
    // Round header
    if (m.round !== lastRound) {
      if (lastRound !== -1) lines.push("");
      lastRound = m.round;
    }

    // Phase header
    if (m.phase !== lastPhase) {
      lastPhase = m.phase;
      // System messages are their own headers
      if (m.phase !== "system") {
        const phaseLabel: Record<string, string> = {
          day: "DISCUSSION",
          vote: "VOTING",
          "wolf-chat": "WOLF CHAT (private)",
          "wolf-strategy": "WOLF STRATEGY (private)",
          doctor: "DOCTOR (private)",
          detective: "DETECTIVE (private)",
          night: "NIGHT",
          reaction: "REACTIONS",
        };
        lines.push(`  [${phaseLabel[m.phase] ?? m.phase.toUpperCase()}]`);
      }
    }

    if (m.phase === "system") {
      lines.push(m.content);
    } else {
      lines.push(`  ${m.playerName}: ${m.content}`);
    }
  }

  lines.push("");
  lines.push("─".repeat(60));
  lines.push("ROLE REVEAL");
  for (const p of run.players) {
    const status = p.alive ? "" : " (dead)";
    lines.push(`  ${p.name} — ${p.role.toUpperCase()}${status}`);
  }

  return lines.join("\n");
}

export async function GET() {
  await ensureDir();
  try {
    const files = await readdir(DIR);
    const runs: MafiaRunRecord[] = [];

    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(path.join(DIR, file), "utf-8");
        runs.push(JSON.parse(raw) as MafiaRunRecord);
      } catch { /* skip corrupt files */ }
    }
    runs.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}

export async function POST(req: NextRequest) {
  await ensureDir();
  const run = (await req.json()) as MafiaRunRecord;
  const jsonPath = path.join(DIR, `${run.id}.json`);
  const txtPath = path.join(DIR, `${run.id}.txt`);

  await writeFile(jsonPath, JSON.stringify(run, null, 2));
  await writeFile(txtPath, buildTranscript(run));

  return NextResponse.json({ success: true }, { status: 201 });
}
