import { resolveProvider } from "./provider.js";
import { runRemote } from "./remote.js";

/**
 * Run LLM extraction on input text, optionally with media.
 *
 * @param {string} input - Page content (markdown or JSON string)
 * @param {object} opts
 * @param {string} [opts.prompt] - Free-form extraction prompt (--extract)
 * @param {object} [opts.schema] - JSON Schema for constrained output (--schema)
 * @param {string} [opts.llm] - Provider name override (--llm)
 * @param {string} opts.stateDir - Path to ~/.lupin state directory
 * @param {number} [opts.timeoutMs] - Inference timeout override (--llm-timeout)
 * @param {Array} [opts.media] - Resolved media content parts (from resolveMedia)
 * @returns {Promise<{ result: string|object, model: string, provider: string, durationMs: number }>}
 */
export async function run(input, { prompt, schema, llm, stateDir, timeoutMs, media } = {}) {
  if (!prompt && !schema) {
    throw new Error("Either --extract <prompt> or --schema <json-schema> is required for LLM extraction.");
  }

  const provider = resolveProvider({ stateDir, llm });
  const startMs = Date.now();
  const hasMedia = Array.isArray(media) && media.length > 0;

  const outcome = await runRemote(input, {
    prompt,
    schema,
    media: hasMedia ? media : undefined,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    timeoutMs: timeoutMs || provider.timeoutMs,
  });

  return {
    result: outcome.result,
    model: outcome.model,
    provider: provider.name,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Resolve the LLM provider config without running extraction.
 * Used by callers that need the model name before calling run().
 */
export function resolveProviderInfo({ stateDir, llm } = {}) {
  return resolveProvider({ stateDir, llm });
}
