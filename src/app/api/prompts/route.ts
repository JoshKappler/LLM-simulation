import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { PromptConfig } from "@/lib/types";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

async function ensureDir() {
  await mkdir(PROMPTS_DIR, { recursive: true });
}

export async function GET() {
  await ensureDir();
  try {
    const files = await readdir(PROMPTS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const configs: PromptConfig[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(path.join(PROMPTS_DIR, file), "utf-8");
        configs.push(JSON.parse(raw) as PromptConfig);
      } catch {
        // skip malformed files
      }
    }
    configs.sort(
      (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
    );
    return NextResponse.json({ configs });
  } catch {
    return NextResponse.json({ configs: [] });
  }
}

export async function POST(req: NextRequest) {
  await ensureDir();
  const config = (await req.json()) as PromptConfig;

  const safeName = config.name
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .slice(0, 60);

  if (!safeName) {
    return NextResponse.json({ error: "Invalid config name." }, { status: 400 });
  }

  const filePath = path.join(PROMPTS_DIR, `${safeName}.json`);
  await writeFile(
    filePath,
    JSON.stringify({ ...config, name: safeName, savedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
  return NextResponse.json({ success: true, name: safeName }, { status: 201 });
}
