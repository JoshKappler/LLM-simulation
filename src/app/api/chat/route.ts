import { NextRequest } from "next/server";
import type { ChatRequest } from "@/lib/types";

export const runtime = "nodejs";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatRequest;

  const ollamaMessages = [
    { role: "system", content: body.system },
    ...body.messages,
  ];

  let ollamaRes: Response;
  try {
    ollamaRes = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        messages: ollamaMessages,
        stream: true,
        think: false,
        options: {
          temperature: body.temperature,
          repeat_penalty: 1.05,
          ...(body.numPredict !== undefined && { num_predict: body.numPredict }),
          ...(body.minP !== undefined && { min_p: body.minP }),
          ...(body.stop !== undefined && { stop: body.stop }),
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
    const body = await ollamaRes.text().catch(() => "(no body)");
    return new Response(
      JSON.stringify({ error: `Ollama ${ollamaRes.status}: ${body}` }),
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
