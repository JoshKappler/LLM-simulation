import { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { getJobBus } from "@/lib/optimizer/eventBus";

export const runtime = "nodejs";

const OPT_DIR = path.join(process.cwd(), "optimization");

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return new Response("jobId required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Replay existing events from ndjson log
      try {
        const eventsPath = path.join(OPT_DIR, jobId, "events.ndjson");
        const raw = await readFile(eventsPath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
      } catch { /* no events yet */ }

      // Subscribe to live events
      const bus = getJobBus(jobId);
      let closed = false;

      const onEvent = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* stream closed */ }
      };

      bus.on("event", onEvent);

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        bus.off("event", onEvent);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
