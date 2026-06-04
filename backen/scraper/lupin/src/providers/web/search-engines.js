import { searchGoogle } from "../google/search.js";
import { searchDuckDuckGo } from "../duckduckgo/search.js";
import { searchBrave } from "../brave/search.js";

const ENGINE_REGISTRY = {
  brave: {
    name: "brave",
    search: searchBrave,
  },
  duckduckgo: {
    name: "duckduckgo",
    search: searchDuckDuckGo,
  },
  google: {
    name: "google",
    search: searchGoogle,
  },
};

const DEFAULT_WEB_ENGINE_ORDER = ["duckduckgo", "google", "brave"];

// Skip engines that failed recently to avoid repeated timeout penalties
const ENGINE_FAILURE_BLACKOUT_MS = 60_000;
const engineFailures = new Map(); // engineName → timestamp of last failure

function markEngineFailed(engineName) {
  engineFailures.set(engineName, Date.now());
}

function isEngineBlackedOut(engineName) {
  const failedAt = engineFailures.get(engineName);
  if (!failedAt) return false;
  if (Date.now() - failedAt > ENGINE_FAILURE_BLACKOUT_MS) {
    engineFailures.delete(engineName);
    return false;
  }
  return true;
}
const JUNK_RESULT_TITLES = new Set([
  "advertise",
  "api",
  "bing",
  "faq",
  "google",
  "images",
  "mojeek",
  "news",
  "privacy policy",
  "sign in",
  "status",
  "terms of use",
  "videos",
]);

function normalizeSiteHost(site) {
  if (!site) return null;

  try {
    const prefixed = /^[a-z]+:\/\//i.test(site) ? site : `https://${site}`;
    return new URL(prefixed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function resultMatchesSite(url, site) {
  const siteHost = normalizeSiteHost(site);
  if (!siteHost) return true;

  try {
    const resultHost = new URL(url).hostname.toLowerCase();
    return resultHost === siteHost || resultHost.endsWith(`.${siteHost}`);
  } catch {
    return false;
  }
}

export function looksLikeSearchChromeResult(result) {
  const title = String(result?.title || "").trim().toLowerCase();
  if (!title) return true;
  if (JUNK_RESULT_TITLES.has(title)) return true;

  const snippet = String(result?.snippet || "").trim();
  if (!snippet && title.length <= 12) return true;

  return false;
}

export function sanitizeSearchResponse(response, options = {}) {
  const inputResults = Array.isArray(response?.results) ? response.results : [];
  const filteredResults = inputResults
    .filter((result) => !looksLikeSearchChromeResult(result))
    .filter((result) => resultMatchesSite(result.url, options.site));

  if (filteredResults.length === inputResults.length) {
    return response;
  }

  // Re-index ranks after filtering to avoid gaps
  const reindexed = filteredResults.map((r, i) => ({ ...r, rank: i + 1 }));

  const warnings = [...(response?.warnings || [])];
  if (options.site && reindexed.length === 0 && inputResults.length > 0) {
    warnings.push(`Filtered ${inputResults.length} results because they did not match the requested site (${options.site}).`);
  } else if (reindexed.length < inputResults.length) {
    warnings.push(`Filtered ${inputResults.length - reindexed.length} low-quality or off-site search results.`);
  }

  return {
    ...response,
    results: reindexed,
    warnings,
  };
}

export function listSearchWebEngines() {
  return Object.keys(ENGINE_REGISTRY);
}

export function listBenchmarkSearchWebEngines() {
  return ["duckduckgo", "google", "brave"].filter((engine) => ENGINE_REGISTRY[engine]);
}

export function resolveSearchWebEngineOrder(options = {}) {
  const requested = options.engine ? [options.engine] : options.preferredEngines;
  const order = Array.isArray(requested) && requested.length > 0 ? requested : DEFAULT_WEB_ENGINE_ORDER;

  for (const engine of order) {
    if (!ENGINE_REGISTRY[engine]) {
      throw new Error(`Unsupported search engine: ${engine}`);
    }
  }

  return order;
}

export async function runSearchWebEngines(query, options = {}, manager) {
  const startedAt = Date.now();
  const attemptedEngines = [];
  const order = resolveSearchWebEngineOrder(options);

  for (const engineName of order) {
    // Skip engines that failed recently (unless explicitly requested)
    if (!options.engine && isEngineBlackedOut(engineName)) {
      attemptedEngines.push({
        engine: engineName,
        ok: false,
        blocked: true,
        resultCount: 0,
        warnings: [`${engineName} skipped (failed recently, retrying in <60s)`],
      });
      continue;
    }

    const engine = ENGINE_REGISTRY[engineName];
    const response = sanitizeSearchResponse(await engine.search(query, options, manager), options);
    const ok = Array.isArray(response.results) && response.results.length > 0;
    const blocked = response.blocked === true;

    attemptedEngines.push({
      engine: engineName,
      ok,
      blocked,
      resultCount: Array.isArray(response.results) ? response.results.length : 0,
      warnings: response.warnings || [],
    });

    if (blocked || !ok) {
      markEngineFailed(engineName);
    }

    if (!blocked && ok) {
      return {
        response,
        engine: engineName,
        attemptedEngines,
      };
    }

    if (options.engine) {
      return {
        response,
        engine: engineName,
        attemptedEngines,
      };
    }
  }

  const lastAttempt = attemptedEngines[attemptedEngines.length - 1] || null;
  return {
    response: {
      provider: "web",
      query,
      usedStrategy: "serp_site_filter",
      snapshotDate: new Date().toISOString().slice(0, 10),
      results: [],
      warnings: lastAttempt?.warnings || ["No search engines returned usable results."],
      blocked: lastAttempt?.blocked === true,
      durationMs: Date.now() - startedAt,
    },
    engine: lastAttempt?.engine || null,
    attemptedEngines,
  };
}
