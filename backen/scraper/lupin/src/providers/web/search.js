import { runSearchWebEngines } from "./search-engines.js";

const MAX_WEB_SEARCH_LIMIT = 200;

export async function searchWeb(query, options = {}, manager) {
  const clampedOptions = {
    ...options,
    limit: Math.min(Math.max(options.limit || 10, 1), MAX_WEB_SEARCH_LIMIT),
  };
  const { response, engine, attemptedEngines } = await runSearchWebEngines(query, clampedOptions, manager);
  return {
    ...response,
    provider: "web",
    usedStrategy: "serp_site_filter",
    engine,
    attemptedEngines,
  };
}
