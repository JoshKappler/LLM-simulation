import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { RunRecord, RunSummary } from "@/lib/types";

const DIR = path.join(process.cwd(), "runs");

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

export async function GET() {
  await ensureDir();
  try {
    const files = await readdir(DIR);
    const summaries: RunSummary[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(path.join(DIR, file), "utf-8");
        const run = JSON.parse(raw) as RunRecord;
        summaries.push({
          id: run.id,
          savedAt: run.savedAt,
          agentAName: run.agentAName,
          agentBName: run.agentBName,
          turnCount: run.turnCount,
          situationSnippet: run.situationSnippet,
        });
      } catch { /* skip */ }
    }
    summaries.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    return NextResponse.json({ runs: summaries });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}

export async function POST(req: NextRequest) {
  await ensureDir();
  const run = (await req.json()) as RunRecord;
  const filePath = path.join(DIR, `${run.id}.json`);
  await writeFile(filePath, JSON.stringify(run, null, 2));
  return NextResponse.json({ success: true }, { status: 201 });
}
