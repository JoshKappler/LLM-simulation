import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/lib/llmClient";

export const runtime = "nodejs";

interface ChatToolsRequest {
  model: string;
  system: string;
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatToolsRequest;

    const messages = [
      { role: "system" as const, content: body.system },
      ...body.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    const llmOpts = {
      model: body.model,
      messages,
      temperature: body.temperature,
      maxTokens: body.maxTokens ?? 512,
    };

    // Try with JSON mode first; if the model can't handle it, retry without
    let result: string;
    try {
      result = await callLLM({ ...llmOpts, responseFormat: { type: "json_object" as const } });
    } catch (jsonErr) {
      const jsonMsg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
      if (jsonMsg.includes("json_validate_failed") || jsonMsg.includes("400") || jsonMsg.includes("not supported")) {
        console.warn(`[chat-tools] JSON mode failed (${body.model}), retrying without: ${jsonMsg.slice(0, 120)}`);
        result = await callLLM(llmOpts);
      } else {
        throw jsonErr;
      }
    }

    return NextResponse.json({ content: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
