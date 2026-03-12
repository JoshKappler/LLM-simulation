import { NextRequest } from "next/server";
import type { ChatRequest } from "@/lib/types";
import { streamLLM } from "@/lib/llmClient";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatRequest;

  const messages = [
    { role: "system" as const, content: body.system },
    ...body.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const stream = streamLLM({
        model: body.model,
        messages,
        temperature: body.temperature,
        ...(body.numPredict !== undefined && { maxTokens: body.numPredict }),
        ...(body.stop?.length && { stop: body.stop }),
        onRateLimit: (waitMs) => {
          const secs = Math.ceil(waitMs / 1000);
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "rate_limit", retryMs: waitMs, retrySecs: secs, done: false }) + "\n",
            ),
          );
        },
      });
      try {
        for await (const chunk of stream) {
          const line =
            JSON.stringify({ message: { role: "assistant", content: chunk }, done: false }) + "\n";
          controller.enqueue(encoder.encode(line));
        }
        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(JSON.stringify({ error: msg, done: true }) + "\n"),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
