import { createPlatformSearch } from "../base/platform-search.js";

const INSTAGRAM_MEDIA_PATH_RE = /instagram\.com\/(?:p|reel|reels)\//i;

export const searchInstagram = createPlatformSearch({
  provider: "instagram",
  site: "instagram.com",
  defaultEngines: ["duckduckgo", "google", "brave"],
  // Instagram SERP results are dominated by profile pages; /p/ and /reel/ URLs
  // are rare even with inurl:p. Keep rate is ~14%, so over-request ~7x.
  overRequestMultiplier: 7,
  filter: (results) =>
    (Array.isArray(results) ? results : []).filter((r) => INSTAGRAM_MEDIA_PATH_RE.test(r?.url || "")),
  queryTransform: (q) => `${q} inurl:p`,
  emptyWarning: "No Instagram post or reel URLs were found from the configured search engines.",
});
