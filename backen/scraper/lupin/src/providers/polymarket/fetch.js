import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { getEventPublishedAt, getPrimaryMarketEndDate, selectPrimaryMarket } from "./common.js";

const GAMMA_API_BASE_URL = "https://gamma-api.polymarket.com";

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractSlug(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/event\/([^/?#]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function buildEventUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

function normalizeMarket(market) {
  const outcomes = parseMaybeJsonArray(market.outcomes);
  const outcomePrices = parseMaybeJsonArray(market.outcomePrices);
  const pairedOutcomes = outcomes.map((label, index) => ({
    label,
    price: parseNumber(outcomePrices[index]),
  }));

  return {
    id: market.id,
    slug: market.slug,
    question: market.question,
    active: Boolean(market.active),
    closed: Boolean(market.closed),
    acceptingOrders: Boolean(market.acceptingOrders),
    outcomes: pairedOutcomes,
    bestBid: parseNumber(market.bestBid),
    bestAsk: parseNumber(market.bestAsk),
    lastTradePrice: parseNumber(market.lastTradePrice),
    spread: parseNumber(market.spread),
    volume: parseNumber(market.volumeNum ?? market.volume),
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    volume24hr: parseNumber(market.volume24hr),
    endDate: market.endDate || null,
    image: market.image || null,
  };
}

function normalizeComment(comment) {
  return {
    id: comment.id,
    text: comment.body || "",
    publishedAt: comment.createdAt || null,
    author: {
      name: comment.profile?.name || comment.profile?.pseudonym || null,
      handle: null,
      url: null,
    },
    reactions: parseNumber(comment.reactionCount),
  };
}

function buildMarkdownContent(content, finalUrl) {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.publishedAt) lines.push(`Created: ${content.publishedAt}`);
  if (content.platform?.primaryMarketEndDate) lines.push(`Primary market ends: ${content.platform.primaryMarketEndDate}`);
  if (content.text) lines.push(content.text);
  if (content.stats) {
    const statLines = Object.entries(content.stats)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    if (statLines.length) lines.push(statLines.join("\n"));
  }
  if (content.platform?.markets?.length) {
    lines.push(
      `Markets:\n${content.platform.markets
        .map((market, index) => `${index + 1}. ${market.question}${market.outcomes.length ? ` (${market.outcomes.map((outcome) => `${outcome.label}: ${outcome.price ?? "n/a"}`).join(", ")})` : ""}`)
        .join("\n")}`
    );
  }
  if (content.comments?.length) {
    lines.push(
      `Comments:\n${content.comments
        .map((comment, index) => `${index + 1}. ${comment.author?.name || "Unknown"}${comment.publishedAt ? `, ${comment.publishedAt}` : ""}: ${comment.text}`)
        .join("\n")}`
    );
  }

  return renderPageMarkdown({
    title: content.title || "Polymarket Market",
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}

export async function fetchPolymarketMarket(scraper, url, options = {}) {
  const startedAt = Date.now();
  const slug = extractSlug(url);
  if (!slug) {
    throw new Error(`Unsupported Polymarket URL: ${url}`);
  }

  const fetcher = scraper?.fetch ? scraper.fetch.bind(scraper) : fetch;
  const eventResponse = await fetcher(`${GAMMA_API_BASE_URL}/events/slug/${slug}`);
  if (!eventResponse.ok) {
    throw new Error(`Polymarket event lookup failed with status ${eventResponse.status}`);
  }
  const event = await eventResponse.json();

  const maxComments = Math.min(Math.max(Number(options.maxComments) || 10, 0), 25);
  let comments = [];
  if (maxComments > 0 && event.id) {
    const commentsUrl = new URL("/comments", GAMMA_API_BASE_URL);
    commentsUrl.searchParams.set("parent_entity_type", "Event");
    commentsUrl.searchParams.set("parent_entity_id", String(event.id));
    commentsUrl.searchParams.set("limit", String(maxComments));
    const commentsResponse = await fetcher(commentsUrl);
    if (commentsResponse.ok) {
      const payload = await commentsResponse.json();
      comments = Array.isArray(payload) ? payload.map(normalizeComment) : [];
    }
  }

  const markets = Array.isArray(event.markets) ? event.markets.map(normalizeMarket) : [];
  const primaryMarket = selectPrimaryMarket(markets);
  const content = {
    entityType: "market",
    title: event.title || null,
    author: null,
    publishedAt: getEventPublishedAt(event),
    text: event.description || "",
    stats: {
      liquidity: parseNumber(event.liquidity),
      volume: parseNumber(event.volume),
      openInterest: parseNumber(event.openInterest),
      volume24hr: parseNumber(event.volume24hr),
      commentCount: parseNumber(event.commentCount),
    },
    media: [event.image, event.icon].filter(Boolean).filter((value, index, items) => items.indexOf(value) === index).map((item) => ({
      type: "image",
      url: item,
    })),
    outboundLinks: [],
    comments,
    platform: {
      site: "polymarket",
      slug: event.slug || slug,
      eventId: event.id || null,
      active: Boolean(event.active),
      closed: Boolean(event.closed),
      restricted: Boolean(event.restricted),
      createdAt: getEventPublishedAt(event),
      updatedAt: event.updatedAt || null,
      primaryMarketQuestion: primaryMarket?.question || null,
      primaryMarketPrice: parseNumber(primaryMarket?.lastTradePrice),
      primaryMarketEndDate: getPrimaryMarketEndDate(markets),
      markets,
      seriesSlug: event.seriesSlug || null,
      context: event.eventMetadata?.context_description || null,
    },
  };

  const format = options.format || "json";
  const finalUrl = buildEventUrl(event.slug || slug);

  return createFetchResponse(
    "polymarket",
    url,
    finalUrl,
    snapshotDateUtc(),
    format,
    format === "markdown" ? buildMarkdownContent(content, finalUrl) : content,
    {
      startedAt,
      warnings: comments.length === 0 && parseNumber(event.commentCount) ? ["Polymarket returned no comments for this event fetch."] : [],
      blocked: false,
      extraction: {
        method: "polymarket_public_api",
        confidence: "high",
      },
    }
  );
}
