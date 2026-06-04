import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";

const HN_FIREBASE_API_BASE_URL = "https://hacker-news.firebaseio.com/v0";

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function stripHtml(text) {
  return decodeHtml(String(text || "").replace(/<p>/gi, "\n\n").replace(/<[^>]+>/g, ""));
}

function extractItemId(url) {
  const parsed = new URL(url);
  return parsed.searchParams.get("id");
}

async function fetchItem(id, fetcher = fetch) {
  const response = await fetcher(`${HN_FIREBASE_API_BASE_URL}/item/${id}.json`);
  if (!response.ok) {
    throw new Error(`HN item fetch failed with status ${response.status}`);
  }
  return response.json();
}

async function fetchComments(ids, maxComments, fetcher, bucket = []) {
  for (const id of ids || []) {
    if (bucket.length >= maxComments) break;
    const item = await fetchItem(id, fetcher);
    if (!item || item.deleted || item.dead || item.type !== "comment") continue;
    bucket.push({
      id: item.id,
      text: stripHtml(item.text),
      publishedAt: toIso(item.time),
      author: {
        name: item.by || null,
        handle: item.by || null,
        url: item.by ? `https://news.ycombinator.com/user?id=${item.by}` : null,
      },
    });
    if (Array.isArray(item.kids) && item.kids.length) {
      await fetchComments(item.kids, maxComments, fetcher, bucket);
    }
  }
  return bucket;
}

function buildMarkdownContent(content, finalUrl) {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.author?.handle) lines.push(content.author.handle);
  if (content.publishedAt) lines.push(content.publishedAt);
  if (content.text) lines.push(content.text);
  if (content.outboundLinks?.length) lines.push(`Link: ${content.outboundLinks[0]}`);
  if (content.stats) {
    const statLines = Object.entries(content.stats)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    if (statLines.length) lines.push(statLines.join("\n"));
  }
  if (content.comments?.length) {
    lines.push(
      `Comments:\n${content.comments
        .map((comment, index) => `${index + 1}. ${comment.author?.handle || comment.author?.name || "Unknown"}${comment.publishedAt ? `, ${comment.publishedAt}` : ""}: ${comment.text}`)
        .join("\n")}`
    );
  }

  return renderPageMarkdown({
    title: content.title || "HN Item",
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}

export async function fetchHnItem(scraper, url, options = {}) {
  const startedAt = Date.now();
  const id = extractItemId(url);
  if (!id) {
    throw new Error(`Unsupported HN URL: ${url}`);
  }

  const fetcher = scraper?.fetch ? scraper.fetch.bind(scraper) : fetch;
  const item = await fetchItem(id, fetcher);
  if (!item) {
    throw new Error(`HN item ${id} was not found`);
  }

  const maxComments = Math.min(Math.max(Number(options.maxComments) || 10, 0), 25);
  const comments = maxComments > 0 ? await fetchComments(item.kids || [], maxComments, fetcher) : [];
  const finalUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const content = {
    entityType: item.type === "job" ? "story" : "thread",
    title: item.title || "(untitled)",
    author: {
      name: item.by || null,
      handle: item.by || null,
      url: item.by ? `https://news.ycombinator.com/user?id=${item.by}` : null,
    },
    publishedAt: toIso(item.time),
    text: stripHtml(item.text),
    stats: {
      points: item.score ?? null,
      commentCount: item.descendants ?? (Array.isArray(item.kids) ? item.kids.length : 0),
    },
    media: [],
    outboundLinks: [item.url].filter(Boolean),
    comments,
    platform: {
      site: "hn",
      itemId: item.id,
      type: item.type,
      descendants: item.descendants ?? null,
    },
  };

  const format = options.format || "json";
  return createFetchResponse(
    "hn",
    url,
    finalUrl,
    snapshotDateUtc(),
    format,
    format === "markdown" ? buildMarkdownContent(content, finalUrl) : content,
    {
      startedAt,
      warnings: [],
      blocked: false,
      extraction: {
        method: "hn_public_api",
        confidence: "high",
      },
    }
  );
}
