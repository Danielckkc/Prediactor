import { createPlatformSearch } from "lupin-cli/providers/base/platform-search";

const X_STATUS_URL_RE = /x\.com\/[^/]+\/status\/\d+/i;

export const searchX = createPlatformSearch({
  provider: "x",
  site: "x.com",
  defaultEngines: ["duckduckgo", "google", "brave"],
  // With inurl:status the keep rate is high; 1.5x covers the edge cases.
  overRequestMultiplier: 1.5,
  filter: (results) =>
    (Array.isArray(results) ? results : []).filter((r) => X_STATUS_URL_RE.test(r?.url || "")),
  queryTransform: (q) => `${q} inurl:status`,
  emptyWarning: "No X post URLs were found from the configured search engines.",
});
