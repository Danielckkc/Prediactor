import { createSearchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";

const HN_ALGOLIA_API_BASE_URL = "https://hn.algolia.com";

function truncate(text, maxLength = 280) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function buildItemUrl(objectId) {
  return `https://news.ycombinator.com/item?id=${objectId}`;
}

function mapSort(sort) {
  return sort === "recent" ? "search_by_date" : "search";
}

function normalizeSearchResult(hit, rank) {
  return {
    rank,
    title: hit.title || hit.story_title || "(untitled)",
    url: buildItemUrl(hit.objectID),
    snippet: truncate(hit.story_text || hit.comment_text || hit.url || ""),
    source: "hn",
    publishedAt: hit.created_at || null,
    author: hit.author || null,
    metadata: {
      objectID: hit.objectID,
      points: hit.points ?? null,
      commentCount: hit.num_comments ?? null,
      storyUrl: hit.url || null,
    },
  };
}

export async function searchHn(query, options = {}, fetcher = fetch) {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 25);
  const endpoint = mapSort(options.sort);
  const url = new URL(`/api/v1/${endpoint}`, HN_ALGOLIA_API_BASE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("tags", "story");
  url.searchParams.set("hitsPerPage", String(limit));

  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`HN search failed with status ${response.status}`);
  }

  const payload = await response.json();
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const results = hits.slice(0, limit).map((hit, index) => normalizeSearchResult(hit, index + 1));

  return createSearchResponse(
    "hn",
    query,
    "hn_algolia_api",
    snapshotDateUtc(),
    results,
    results.length === 0 ? ["HN returned no matching stories."] : [],
    false,
    startedAt
  );
}
