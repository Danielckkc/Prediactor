import { createSearchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { getEventPublishedAt, getPrimaryMarketEndDate, selectPrimaryMarket } from "./common.js";

const GAMMA_API_BASE_URL = "https://gamma-api.polymarket.com";

function buildEventUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

function truncate(text, maxLength = 280) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSearchResult(event, rank) {
  const primaryMarket = selectPrimaryMarket(event.markets);
  return {
    rank,
    title: event.title,
    url: buildEventUrl(event.slug),
    snippet: truncate(event.description),
    source: "polymarket",
    publishedAt: getEventPublishedAt(event),
    author: null,
    metadata: {
      eventId: event.id,
      slug: event.slug,
      active: Boolean(event.active),
      closed: Boolean(event.closed),
      updatedAt: event.updatedAt || null,
      volume: parseNumber(event.volume),
      liquidity: parseNumber(event.liquidity),
      commentCount: parseNumber(event.commentCount),
      marketCount: Array.isArray(event.markets) ? event.markets.length : 0,
      topMarketQuestion: primaryMarket?.question || null,
      topMarketPrice: parseNumber(primaryMarket?.lastTradePrice),
      primaryMarketEndDate: getPrimaryMarketEndDate(event.markets),
    },
  };
}

export async function searchPolymarket(query, options = {}, fetcher = fetch) {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 20);
  const url = new URL("/public-search", GAMMA_API_BASE_URL);
  url.searchParams.set("q", query);

  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Polymarket search failed with status ${response.status}`);
  }

  const payload = await response.json();
  const events = Array.isArray(payload.events) ? payload.events : [];
  const results = events.slice(0, limit).map((event, index) => normalizeSearchResult(event, index + 1));

  return createSearchResponse(
    "polymarket",
    query,
    "polymarket_public_api",
    snapshotDateUtc(),
    results,
    results.length === 0 ? ["Polymarket returned no matching public events."] : [],
    false,
    startedAt
  );
}
