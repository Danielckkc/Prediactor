import { createPlatformSearch } from "../base/platform-search.js";

const TIKTOK_VIDEO_URL_RE = /tiktok\.com\/@[^/]+\/video\/\d+/i;

export const searchTiktok = createPlatformSearch({
  provider: "tiktok",
  site: "tiktok.com",
  defaultEngines: ["duckduckgo", "google", "brave"],
  // inurl:video helps but SERP still surfaces ads.tiktok.com and newsroom pages.
  // Observed keep rate varies ~40-90%, so 2.5x is a safe middle ground.
  overRequestMultiplier: 2.5,
  filter: (results) =>
    (Array.isArray(results) ? results : []).filter((r) => TIKTOK_VIDEO_URL_RE.test(r?.url || "")),
  queryTransform: (q) => `${q} inurl:video`,
  emptyWarning: "No TikTok video URLs were found from the configured search engines.",
});
