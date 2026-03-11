import { NextResponse } from "next/server";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const DEFAULT_MODEL = "huihui_ai/qwen3-abliterated:30b-a3b-instruct-2507-q4_K_M";

export async function GET() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = (await res.json()) as { models: Array<{ name: string }> };
    const names = data.models.map((m) => m.name);
    return NextResponse.json({ models: names.length > 0 ? names : [DEFAULT_MODEL] });
  } catch {
    return NextResponse.json({ models: [DEFAULT_MODEL] });
  }
}
