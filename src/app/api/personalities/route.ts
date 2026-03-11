import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { PersonalityPreset } from "@/lib/types";
import { BUILT_IN_PERSONALITIES } from "@/lib/presets";

const DIR = path.join(process.cwd(), "personalities");

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

export async function GET() {
  await ensureDir();
  try {
    const files = await readdir(DIR);
    const userPresets: PersonalityPreset[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(path.join(DIR, file), "utf-8");
        userPresets.push(JSON.parse(raw) as PersonalityPreset);
      } catch { /* skip malformed */ }
    }
    return NextResponse.json({ personalities: [...BUILT_IN_PERSONALITIES, ...userPresets] });
  } catch {
    return NextResponse.json({ personalities: BUILT_IN_PERSONALITIES });
  }
}

export async function POST(req: NextRequest) {
  await ensureDir();
  const preset = (await req.json()) as PersonalityPreset;
  const safeId = preset.name.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 60)
    .toLowerCase().replace(/\s+/g, "-");
  if (!safeId) return NextResponse.json({ error: "Invalid name." }, { status: 400 });
  const filePath = path.join(DIR, `${safeId}.json`);
  await writeFile(filePath, JSON.stringify({ ...preset, id: safeId, isBuiltIn: false }, null, 2));
  return NextResponse.json({ success: true, id: safeId }, { status: 201 });
}
