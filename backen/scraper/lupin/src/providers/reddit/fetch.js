import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { userAgent } from "../../version.js";

const REDDIT_BASE_URL = "https://www.reddit.com";
const DEFAULT_HEADERS = {
  "User-Agent": userAgent,
};

function buildJsonThreadUrl(url, maxComments) {
  const parsed = new URL(url);
  const normalizedPath = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return `${REDDIT_BASE_URL}${normalizedPath}.json?limit=${maxComments}`;
}

function toIso(createdUtc) {
  return createdUtc ? new Date(createdUtc * 1000).toISOString() : null;
}

function normalizeComment(node) {
  const data = node?.data;
  if (!data?.body || data.body === "[deleted]") return null;
  return {
    id: data.id,
    text: data.body,
    publishedAt: toIso(data.created_utc),
    author: {
      name: data.author || null,
      handle: data.author ? `u/${data.author}` : null,
      url: data.author ? `https://www.reddit.com/user/${data.author}/` : null,
    },
    score: data.score ?? null,
  };
}

function flattenComments(children, bucket = []) {
  for (const child of children || []) {
    if (child?.kind !== "t1") continue;
    const normalized = normalizeComment(child);
    if (normalized) {
      bucket.push(normalized);
    }
    const replies = child?.data?.replies?.data?.children;
    if (Array.isArray(replies) && replies.length) {
      flattenComments(replies, bucket);
    }
  }
  return bucket;
}

function isLikelyBot(comment) {
  const handle = String(comment?.author?.handle || "").toLowerCase();
  const text = String(comment?.text || "").toLowerCase();
  return handle.endsWith("bot") || /\bi am a bot\b|\bperformed automatically\b/.test(text);
}

function selectTopComments(children, maxComments) {
  return flattenComments(children)
    .sort((left, right) => {
      const leftBotPenalty = isLikelyBot(left) ? 1 : 0;
      const rightBotPenalty = isLikelyBot(right) ? 1 : 0;
      if (leftBotPenalty !== rightBotPenalty) {
        return leftBotPenalty - rightBotPenalty;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    })
    .slice(0, maxComments);
}

function buildMarkdownContent(content, finalUrl) {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.author?.handle) lines.push(content.author.handle);
  if (content.publishedAt) lines.push(content.publishedAt);
  if (content.text) lines.push(content.text);
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
    title: content.title || "Reddit Post",
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}

function parseSubredditFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/r\/([^/]+)/i);
    return match ? `r/${match[1]}` : null;
  } catch {
    return null;
  }
}

function extractRenderedTitle(scrapeResult) {
  const heading = scrapeResult.headings?.find((item) => item.level === 1)?.text;
  return heading || String(scrapeResult.title || "").replace(/\s*:\s*r\/[^|]+.*$/i, "").trim() || "Reddit Post";
}

function extractRenderedAuthor(text, title, links = []) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const titleIndex = lines.findIndex((line) => line === title);
  if (titleIndex > 0) {
    for (let index = titleIndex - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (/^\d+[smhdwy]\s+ago$/i.test(candidate) || /^go to /i.test(candidate)) continue;
      return candidate;
    }
  }
  const userLink = links.find((link) => /\/user\/[^/]+\/?$/i.test(link.href || ""));
  if (userLink?.text) return userLink.text;
  return null;
}

async function fetchRedditRenderedFallback(scraper, url, options, startedAt, reason) {
  if (!scraper?.scrape) {
    throw new Error(`Reddit thread fetch failed with status ${reason}`);
  }

  const scrapeResult = await scraper.scrape(url, {
    engine: options.engine || "auto",
    timeout: options.timeout,
  });
  const finalUrl = scrapeResult.finalUrl || scrapeResult.url || url;
  const title = extractRenderedTitle(scrapeResult);
  const authorName = extractRenderedAuthor(scrapeResult.text, title, scrapeResult.links || []);
  const authorHandle = authorName ? (authorName.startsWith("u/") ? authorName : `u/${authorName}`) : null;
  const subreddit = parseSubredditFromUrl(url);
  const content = {
    entityType: "thread",
    title,
    author: {
      name: authorName,
      handle: authorHandle,
      url: authorName && authorName !== "[deleted]" ? `https://www.reddit.com/user/${authorName.replace(/^u\//, "")}/` : null,
    },
    publishedAt: scrapeResult.publishedAt || null,
    text: scrapeResult.text || "",
    stats: {
      score: null,
      upvoteRatio: null,
      commentCount: null,
    },
    media: (scrapeResult.images || [])
      .filter((image) => /^https?:/i.test(image.src || ""))
      .map((image) => ({ type: "image", url: image.src })),
    outboundLinks: (scrapeResult.links || [])
      .map((link) => link.href)
      .filter((href) => href && !/reddit\.com\/(r|user|login|register|search)\//i.test(href)),
    comments: [],
    platform: {
      site: "reddit",
      subreddit,
      permalink: url,
      isSelf: null,
      over18: null,
    },
  };
  const format = options.format || "json";

  return createFetchResponse(
    "reddit",
    url,
    finalUrl,
    snapshotDateUtc(),
    format,
    format === "markdown" ? buildMarkdownContent(content, finalUrl) : content,
    {
      startedAt,
      warnings: [`Reddit public JSON thread fetch failed (${reason}); fell back to rendered page extraction.`],
      blocked: false,
      extraction: {
        method: "reddit_rendered_page_fallback",
        confidence: "medium",
      },
    }
  );
}

export async function fetchRedditPost(scraper, url, options = {}) {
  const startedAt = Date.now();
  const maxComments = Math.min(Math.max(Number(options.maxComments) || 10, 0), 25);
  const commentPoolSize = Math.min(Math.max(maxComments * 4, 20), 100);
  const fetcher = scraper?.fetch ? scraper.fetch.bind(scraper) : fetch;
  const response = await fetcher(buildJsonThreadUrl(url, commentPoolSize), { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    return fetchRedditRenderedFallback(scraper, url, options, startedAt, `HTTP ${response.status}`);
  }

  const payload = await response.json();
  const post = payload?.[0]?.data?.children?.[0]?.data;
  const commentChildren = payload?.[1]?.data?.children || [];
  if (!post) {
    throw new Error(`Reddit thread payload did not include a post for ${url}`);
  }

  const comments = selectTopComments(commentChildren, maxComments);
  const content = {
    entityType: "thread",
    title: post.title || null,
    author: {
      name: post.author || null,
      handle: post.author ? `u/${post.author}` : null,
      url: post.author ? `https://www.reddit.com/user/${post.author}/` : null,
    },
    publishedAt: toIso(post.created_utc),
    text: post.selftext || "",
    stats: {
      score: post.score ?? null,
      upvoteRatio: post.upvote_ratio ?? null,
      commentCount: post.num_comments ?? null,
    },
    media: post.thumbnail && /^https?:/i.test(post.thumbnail)
      ? [
          {
            type: "image",
            url: post.thumbnail,
          },
        ]
      : [],
    outboundLinks: [post.url_overridden_by_dest || post.url].filter(Boolean),
    comments,
    platform: {
      site: "reddit",
      subreddit: post.subreddit_name_prefixed || null,
      permalink: post.permalink ? new URL(post.permalink, REDDIT_BASE_URL).toString() : url,
      isSelf: Boolean(post.is_self),
      over18: Boolean(post.over_18),
    },
  };

  const format = options.format || "json";
  const finalUrl = content.platform.permalink || url;

  return createFetchResponse(
    "reddit",
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
        method: "reddit_public_json",
        confidence: "high",
      },
    }
  );
}
