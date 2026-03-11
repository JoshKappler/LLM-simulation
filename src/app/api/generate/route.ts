import { NextRequest } from "next/server";

export const runtime = "nodejs";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export async function POST(req: NextRequest) {
  const body = await req.json();

  let ollamaRes: Response;
  try {
    ollamaRes = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        prompt: body.prompt,
        system: body.system,
        stream: true,
        think: false,
        options: {
          temperature: body.temperature,
          repeat_penalty: 1.3,
          stop: body.stop ?? [],
        },
      }),
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Could not connect to Ollama. Is it running?" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!ollamaRes.ok || !ollamaRes.body) {
    const errBody = await ollamaRes.text().catch(() => "(no body)");
    return new Response(
      JSON.stringify({ error: `Ollama ${ollamaRes.status}: ${errBody}` }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(ollamaRes.body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
