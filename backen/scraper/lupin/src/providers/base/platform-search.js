import { searchWeb as defaultSearchWeb } from "../web/search.js";
import { overRequestLimit, retryLimit, mergeAndReindex } from "./over-request.js";

/**
 * Shared loop for social-platform SERP searches (X, Instagram, TikTok).
 *
 * These providers all share the same flow:
 *   1. Query a generic search engine restricted to the target site.
 *   2. Filter raw results to a platform-specific URL pattern (posts, reels, videos).
 *   3. Over-request to compensate for the filter's low keep-rate, retry once if short.
 *   4. Iterate preferred engines until one returns useful results.
 *
 * Each caller provides the provider-specific bits via the config object.
 *
 * @param {object} config
 * @param {string} config.provider               - Logical provider name ("x", "instagram", "tiktok").
 * @param {string} config.site                   - Domain passed as `site:` to the engine.
 * @param {string[]} config.defaultEngines       - Engine order when none is explicitly requested.
 * @param {number} config.overRequestMultiplier  - Inverse of expected keep-rate (e.g., 7 for ~14%).
 * @param {(r: object[]) => object[]} config.filter - Keeps only URLs matching the platform pattern.
 * @param {(q: string) => string} [config.queryTransform] - Optional query mutation (e.g., add `inurl:status`).
 * @param {string} config.emptyWarning           - Warning text when no engines yielded anything.
 * @param {(q: string, o: object, m: any) => Promise<object>} [config.searchWeb] - Injectable searchWeb for testing.
 */
export function createPlatformSearch(config) {
  const {
    provider,
    site,
    defaultEngines,
    overRequestMultiplier,
    filter,
    queryTransform = (q) => q,
    emptyWarning,
    searchWeb = defaultSearchWeb,
  } = config;

  async function fetchFilteredFromEngine(query, options, engineName, fetchLimit, manager) {
    const response = await searchWeb(
      queryTransform(query),
      { ...options, site, engine: engineName, limit: fetchLimit },
      manager
    );
    return { response, filtered: filter(response.results) };
  }

  /**
   * Fetch from one engine with over-request, and retry once with a higher
   * multiplier if the first pass didn't meet the target.
   * Returns the final filtered+sliced results along with the last raw response
   * and tracking metadata about what the URL filter inspected vs kept.
   */
  async function fetchWithRetry(query, options, engineName, targetLimit, firstFetchLimit, manager) {
    const first = await fetchFilteredFromEngine(query, options, engineName, firstFetchLimit, manager);

    let filteredResults = first.filtered;
    let lastResponse = first.response;
    const combinedWarnings = [...(first.response.warnings || [])];
    let totalRawResults = lastResponse.results?.length || 0;
    let totalKeptByFilter = first.filtered.length;
    let retried = false;

    if (filteredResults.length < targetLimit && !first.response.blocked) {
      const retryFetchLimit = retryLimit(targetLimit, overRequestMultiplier);
      if (retryFetchLimit > firstFetchLimit) {
        const retry = await fetchFilteredFromEngine(query, options, engineName, retryFetchLimit, manager);
        filteredResults = mergeAndReindex(filteredResults, retry.filtered, targetLimit);
        lastResponse = retry.response;
        combinedWarnings.push(...(retry.response.warnings || []));
        totalRawResults = retry.response.results?.length || 0;
        totalKeptByFilter = retry.filtered.length;
        retried = true;
      }
    }

    // If the retry path didn't run, mergeAndReindex hasn't sliced/re-ranked — do it here
    if (!retried) {
      filteredResults = filteredResults.slice(0, targetLimit).map((r, i) => ({ ...r, rank: i + 1 }));
    }

    return {
      filteredResults,
      lastResponse,
      warnings: combinedWarnings,
      totalRawResults,
      totalKeptByFilter,
    };
  }

  /**
   * Build a single consolidated attempted-engine entry reflecting the
   * final user-facing result count, not the over-requested engine-level count.
   */
  function buildAttemptedEntry(engineName, filteredResults, lastResponse) {
    return {
      engine: engineName,
      ok: filteredResults.length > 0,
      blocked: lastResponse.blocked === true,
      resultCount: filteredResults.length,
      warnings: lastResponse.warnings || [],
    };
  }

  /**
   * Normalize one engine iteration's output into the public provider response shape.
   */
  function normalizeResponse(lastResponse, filteredResults, warnings, attemptedEngines) {
    return {
      ...lastResponse,
      provider,
      usedStrategy: "serp_site_filter",
      results: filteredResults,
      warnings,
      attemptedEngines: [...attemptedEngines],
    };
  }

  /**
   * Empty-state fallback when every preferred engine came back blocked or empty.
   */
  function buildEmptyResponse(query, fallbackResponse, attemptedEngines) {
    return {
      ...(fallbackResponse || {
        provider,
        query,
        usedStrategy: "serp_site_filter",
        snapshotDate: new Date().toISOString().slice(0, 10),
        results: [],
        warnings: [],
        blocked: false,
        durationMs: null,
        engine: null,
      }),
      provider,
      usedStrategy: "serp_site_filter",
      attemptedEngines,
      warnings: [...((fallbackResponse?.warnings) || []), emptyWarning],
    };
  }

  return async function searchPlatform(query, options = {}, manager) {
    const preferredEngines = options.engine ? [options.engine] : (options.preferredEngines || defaultEngines);
    const targetLimit = options.limit || 10;
    const firstFetchLimit = overRequestLimit(targetLimit, overRequestMultiplier);
    const attemptedEngines = [];
    let fallbackResponse = null;

    for (const engineName of preferredEngines) {
      const {
        filteredResults,
        lastResponse,
        warnings,
        totalRawResults,
        totalKeptByFilter,
      } = await fetchWithRetry(query, options, engineName, targetLimit, firstFetchLimit, manager);

      attemptedEngines.push(buildAttemptedEntry(engineName, filteredResults, lastResponse));

      const normalized = normalizeResponse(lastResponse, filteredResults, warnings, attemptedEngines);
      fallbackResponse = normalized;

      // Return early only on success or when the user explicitly pinned an engine.
      // On blocked/empty results, continue to the next engine so transient
      // throttling or anti-bot blocks on one provider don't hide the others.
      if (filteredResults.length > 0 || options.engine) {
        return normalized;
      }
    }

    return buildEmptyResponse(query, fallbackResponse, attemptedEngines);
  };
}
