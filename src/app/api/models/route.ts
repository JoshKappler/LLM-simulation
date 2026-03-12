import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
const API_KEY = process.env.GROQ_API_KEY ?? "";

// Fallback list of known-good Groq model IDs (used if the live fetch fails)
const FALLBACK_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

export async function GET() {
  if (!API_KEY) {
    console.warn("[models] GROQ_API_KEY is not set — returning fallback list");
    return NextResponse.json({ models: FALLBACK_MODELS, warning: "GROQ_API_KEY not set" });
  }

  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data: Array<{ id: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => !id.includes("whisper") && !id.includes("tts") && !id.includes("guard"));
    return NextResponse.json({ models: models.length > 0 ? models : FALLBACK_MODELS });
  } catch (err) {
    console.error("[models] Failed to fetch live model list from Groq:", err);
    return NextResponse.json({ models: FALLBACK_MODELS });
  }
}
