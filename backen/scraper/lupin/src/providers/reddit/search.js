import { createSearchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { userAgent } from "../../version.js";
import { searchWeb } from "../web/search.js";

const REDDIT_BASE_URL = "https://www.reddit.com";
const DEFAULT_HEADERS = {
  "User-Agent": userAgent,
};

function truncate(text, maxLength = 280) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function buildRedditUrl(permalink) {
  return permalink ? new URL(permalink, REDDIT_BASE_URL).toString() : null;
}

function mapSort(sort) {
  return sort === "recent" ? "new" : "relevance";
}

function normalizeSearchResult(post, rank) {
  return {
    rank,
    title: post.title,
    url: buildRedditUrl(post.permalink),
    snippet: truncate(post.selftext || post.title),
    source: "reddit",
    publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    author: post.author ? `u/${post.author}` : null,
    metadata: {
      subreddit: post.subreddit_name_prefixed || null,
      score: post.score ?? null,
      commentCount: post.num_comments ?? null,
      over18: Boolean(post.over_18),
      isSelf: Boolean(post.is_self),
    },
  };
}

function normalizeWebSearchResult(result, rank) {
  return {
    ...result,
    rank,
    source: "reddit",
    metadata: {
      ...(result.metadata || {}),
      via: result.source || "web",
    },
  };
}

async function searchRedditViaWeb(query, options, manager, startedAt, reason) {
  const webResponse = await searchWeb(query, {
    ...options,
    site: "reddit.com",
  }, manager);
  const results = (webResponse.results || [])
    .filter((result) => /reddit\.com\/r\//i.test(result.url || ""))
    .slice(0, options.limit)
    .map((result, index) => normalizeWebSearchResult(result, index + 1));
  const warnings = [
    `Reddit public JSON search failed (${reason}); fell back to web search.`,
    ...(webResponse.warnings || []),
  ];

  return createSearchResponse(
    "reddit",
    query,
    `reddit_web_search_fallback:${webResponse.engine || "web"}`,
    snapshotDateUtc(),
    results,
    results.length === 0 ? [...warnings, "Web search returned no matching Reddit posts."] : warnings,
    webResponse.blocked === true && results.length === 0,
    startedAt
  );
}

export async function searchReddit(query, options = {}, fetcher = fetch, manager = undefined) {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 25);
  const url = new URL("/search.json", REDDIT_BASE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("sort", mapSort(options.sort));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("restrict_sr", "false");

  const response = await fetcher(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    return searchRedditViaWeb(query, { ...options, limit }, manager, startedAt, `HTTP ${response.status}`);
  }

  const payload = await response.json();
  const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
  const results = children
    .map((child) => child?.data)
    .filter(Boolean)
    .slice(0, limit)
    .map((post, index) => normalizeSearchResult(post, index + 1));

  return createSearchResponse(
    "reddit",
    query,
    "reddit_public_json",
    snapshotDateUtc(),
    results,
    results.length === 0 ? ["Reddit returned no matching public posts."] : [],
    false,
    startedAt
  );
}
