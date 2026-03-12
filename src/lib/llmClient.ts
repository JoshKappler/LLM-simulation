/**
 * Shared LLM client — wraps Groq's OpenAI-compatible API.
 * Set GROQ_API_KEY in .env.local. GROQ_BASE_URL can override the base URL
 * (e.g. to point at OpenRouter or another compatible provider).
 *
 * Handles Groq 429 rate limits automatically: parses the suggested wait time
 * from the error response and retries after sleeping.
 */

const BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
const API_KEY = process.env.GROQ_API_KEY ?? "";

const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_MS = 15_000; // fallback if we can't parse the wait time

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: { type: "json_object" | "text" };
  signal?: AbortSignal;
  onRateLimit?: (waitMs: number) => void;
}

// ── Rate limit helpers ──────────────────────────────────────────────────────────

function parseRetryWaitMs(res: Response, body: string): number {
  // 1. Check retry-after header
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 500;
  }

  // 2. Parse from Groq error body: "Please try again in 2.219999999s"
  const match = body.match(/try again in ([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 500;
  }

  return DEFAULT_RETRY_MS;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Non-streaming call ──────────────────────────────────────────────────────────

/** Non-streaming call — returns full response text. Retries on 429. */
export async function callLLM(opts: LLMOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.85,
    stream: false,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.stop?.length) body.stop = opts.stop;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const errorBody = await res.text().catch(() => "");
      const waitMs = parseRetryWaitMs(res, errorBody);
      console.log(`[llmClient] 429 rate limited (${opts.model}), waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`);
      opts.onRateLimit?.(waitMs);
      await sleepWithSignal(waitMs, opts.signal);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`Groq ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content?.trim() ?? "";
  }

  throw new Error(`Groq rate limit: exceeded ${MAX_RATE_LIMIT_RETRIES} retries for ${opts.model}`);
}

// ── Streaming call ──────────────────────────────────────────────────────────────

/** Streaming call — yields text chunks as they arrive. Retries on 429. */
export async function* streamLLM(opts: LLMOptions): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.85,
    stream: true,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.stop?.length) body.stop = opts.stop;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  // Retry loop around fetch — retries 429s before we start streaming
  let res: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const fetchRes = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (fetchRes.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const errorBody = await fetchRes.text().catch(() => "");
      const waitMs = parseRetryWaitMs(fetchRes, errorBody);
      console.log(`[llmClient] 429 rate limited (${opts.model}), waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`);
      opts.onRateLimit?.(waitMs);
      await sleepWithSignal(waitMs, opts.signal);
      continue;
    }

    if (!fetchRes.ok || !fetchRes.body) {
      const text = await fetchRes.text().catch(() => "(no body)");
      throw new Error(`Groq ${fetchRes.status}: ${text}`);
    }

    res = fetchRes;
    break;
  }

  if (!res || !res.body) {
    throw new Error(`Groq rate limit: exceeded ${MAX_RATE_LIMIT_RETRIES} retries for ${opts.model}`);
  }

  // Stream the response
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string }; finish_reason?: string | null }>;
          };
          const content = chunk.choices[0]?.delta?.content;
          if (content) yield content;
        } catch { /* partial line */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
