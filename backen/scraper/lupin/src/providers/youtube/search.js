import { createSearchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { userAgent } from "../../version.js";

const YOUTUBE_BASE_URL = "https://www.youtube.com";
const DEFAULT_HEADERS = {
  "User-Agent": userAgent,
};

function truncate(text, maxLength = 280) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function extractInitialData(html) {
  const match =
    html.match(/var ytInitialData = (.*?);<\/script>/s) ||
    html.match(/window\["ytInitialData"\] = (.*?);<\/script>/s);
  if (!match) {
    throw new Error("YouTube search page did not expose ytInitialData");
  }
  return JSON.parse(match[1]);
}

function getRunsText(node) {
  if (!node) return "";
  if (node.simpleText) return node.simpleText;
  return (node.runs || []).map((run) => run.text || "").join("").trim();
}

function collectVideoRenderers(node, bucket = []) {
  if (!node || bucket.length >= 50) return bucket;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, bucket);
    return bucket;
  }
  if (typeof node !== "object") return bucket;
  if (node.videoRenderer) {
    bucket.push(node.videoRenderer);
  }
  for (const value of Object.values(node)) {
    collectVideoRenderers(value, bucket);
  }
  return bucket;
}

function normalizeSearchResult(video, rank) {
  return {
    rank,
    title: getRunsText(video.title),
    url: `${YOUTUBE_BASE_URL}/watch?v=${video.videoId}`,
    snippet: truncate(getRunsText(video.detailedMetadataSnippets?.[0]?.snippetText) || getRunsText(video.descriptionSnippet)),
    source: "youtube",
    publishedAt: getRunsText(video.publishedTimeText) || null,
    author: getRunsText(video.ownerText) || null,
    metadata: {
      videoId: video.videoId,
      channelId: video.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,
      duration: getRunsText(video.lengthText) || null,
      views: getRunsText(video.viewCountText) || null,
    },
  };
}

export async function searchYoutube(query, options = {}, fetcher = fetch) {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 25);
  const url = new URL("/results", YOUTUBE_BASE_URL);
  url.searchParams.set("search_query", query);

  const response = await fetcher(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`YouTube search failed with status ${response.status}`);
  }

  const html = await response.text();
  const data = extractInitialData(html);
  const videoRenderers = collectVideoRenderers(
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || []
  );
  const results = videoRenderers.slice(0, limit).map((video, index) => normalizeSearchResult(video, index + 1));

  return createSearchResponse(
    "youtube",
    query,
    "youtube_page_embedded_json",
    snapshotDateUtc(),
    results,
    results.length === 0 ? ["YouTube returned no parseable video results."] : [],
    false,
    startedAt
  );
}
