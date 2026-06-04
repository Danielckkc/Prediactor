import { buildSystemPrompt, buildUserMessage } from "./prompts.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS = new Set([401, 403]);

export async function runRemote(input, { prompt, schema, media, baseUrl, apiKey, model, timeoutMs }) {
  const hasMedia = Array.isArray(media) && media.length > 0;
  const systemPrompt = buildSystemPrompt({ prompt, schema, hasMedia });
  const userMessage = buildUserMessage(input, { prompt, schema, media: hasMedia ? media : undefined });
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  };

  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "extraction", strict: true, schema },
    };
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let lastError;
  let _nextBackoffMs = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, _nextBackoffMs));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        clearTimeout(timer);
        if (NON_RETRYABLE_STATUS.has(response.status)) {
          throw new Error(`LLM provider returned HTTP ${response.status}: ${errorText}`);
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          // Respect Retry-After header on 429, fall back to exponential backoff
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter && response.status === 429) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds)) {
              _nextBackoffMs = seconds * 1000;
            } else {
              // Try HTTP-date format (e.g. "Wed, 09 Apr 2026 12:00:00 GMT")
              const date = new Date(retryAfter);
              _nextBackoffMs = Number.isFinite(date.getTime())
                ? Math.max(0, date.getTime() - Date.now())
                : 1000 * 2 ** attempt;
            }
          } else {
            _nextBackoffMs = 1000 * 2 ** attempt;
          }
          lastError = new Error(`HTTP ${response.status}: ${errorText}`);
          continue;
        }
        throw new Error(`LLM provider returned HTTP ${response.status} after ${attempt + 1} attempts: ${errorText}`);
      }

      const json = await response.json();
      clearTimeout(timer);
      const content = json.choices?.[0]?.message?.content;
      if (content === undefined || content === null) {
        throw new Error("LLM response contained no content");
      }

      if (schema) {
        try {
          return { result: JSON.parse(content), model: json.model || model };
        } catch {
          if (attempt < MAX_RETRIES) {
            lastError = new Error("LLM returned invalid JSON despite schema constraint");
            continue;
          }
          throw new Error("LLM returned invalid JSON despite schema constraint");
        }
      }

      return { result: content, model: json.model || model };
    } catch (error) {
      clearTimeout(timer);
      if (error.name === "AbortError") {
        throw new Error(`LLM inference timed out after ${timeout / 1000}s.`);
      }
      if (error.message?.includes("timed out")) throw error;
      if (error.message?.includes("HTTP 401") || error.message?.includes("HTTP 403")) throw error;
      if (attempt < MAX_RETRIES) {
        _nextBackoffMs = 1000 * 2 ** attempt;
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("LLM request failed after retries");
}
