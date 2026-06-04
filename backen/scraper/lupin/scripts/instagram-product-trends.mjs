#!/usr/bin/env node
/**
 * Collect Instagram product-trend posts/reels, rank by likes, write JSON.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchInstagram } from "../src/providers/instagram/search.js";
import { fetchInstagramPost } from "../src/providers/instagram/fetch.js";
import { BrowserManager } from "../src/runtime/browser-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_QUERIES = [
  "instagram shop viral product",
  "amazon finds instagram reel",
  "instagram made me buy it",
  "small business instagram product",
  "instagram shop bestseller",
  "gift ideas instagram reel",
  "must have amazon instagram",
  "product review instagram",
];

const DISCOVERY_HASHTAGS = [
  "amazonfinds",
  "instagramshop",
  "tiktokmademebuyit",
  "smallbusiness",
  "shopnow",
  "giftideas",
  "musthave",
];

const SHOP_HASHTAGS = new Set([
  "amazonfinds",
  "instagramshop",
  "shopnow",
  "smallbusiness",
  "giftideas",
  "musthave",
  "amazonmusthaves",
  "productreview",
  "affiliate",
  "linkinbio",
]);

const PRODUCT_LINE_RE =
  /(?:this|the|my|got|buy|link in bio|shop|check out|obsessed with)\s+(.{4,80}?)(?:\.|!|\?|#|$)/i;

function parseArgs(argv) {
  const opts = {
    target: 300,
    output: path.join(ROOT, "instagram-product-trends.json"),
    discoverOnly: false,
    concurrency: 4,
    delayMs: 400,
    searchLimit: 200,
    queries: [...DEFAULT_QUERIES],
    urlsFile: null,
    skipSearch: false,
    skipHashtagBrowse: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" && argv[i + 1]) opts.target = Number(argv[++i]);
    else if (arg === "--output" && argv[i + 1]) opts.output = path.resolve(argv[++i]);
    else if (arg === "--concurrency" && argv[i + 1]) opts.concurrency = Number(argv[++i]);
    else if (arg === "--delay" && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    else if (arg === "--search-limit" && argv[i + 1]) opts.searchLimit = Number(argv[++i]);
    else if (arg === "--urls-file" && argv[i + 1]) opts.urlsFile = path.resolve(argv[++i]);
    else if (arg === "--skip-search") opts.skipSearch = true;
    else if (arg === "--skip-hashtag-browse") opts.skipHashtagBrowse = true;
    else if (arg === "--discover-only") opts.discoverOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/instagram-product-trends.mjs [options]

Options:
  --target <n>           Top posts by like count (default: 300)
  --output <path>        JSON output path
  --urls-file <path>     Your own post/reel URLs
  --concurrency <n>      Parallel fetches (default: 4)
  --delay <ms>           Delay between batches (default: 400)
  --search-limit <n>     URLs per query, max 200
  --skip-search          Skip SERP discovery
  --skip-hashtag-browse  Skip hashtag pages
  --discover-only        URLs only, no fetch
`);
      process.exit(0);
    }
  }

  opts.target = Math.max(1, Math.min(opts.target, 500));
  opts.searchLimit = Math.max(10, Math.min(opts.searchLimit, 200));
  opts.concurrency = Math.max(1, Math.min(opts.concurrency, 12));
  return opts;
}

function computePools(target) {
  if (target <= 10) {
    const fetchPool = target + 2;
    return { discoverPool: fetchPool, fetchPool };
  }
  const fetchPool = Math.min(target + 50, Math.ceil(target * 1.15));
  return { discoverPool: fetchPool, fetchPool };
}

function normalizePostUrl(url) {
  const match = String(url || "").match(
    /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels)\/[^/?#]+)/i
  );
  if (!match) return null;
  return match[1].replace(/\/reels\//i, "/reel/");
}

function parseCountLabel(text) {
  const cleaned = String(text || "").trim().replace(/,/g, "");
  if (!cleaned) return null;
  const match = cleaned.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) {
    const digits = parseInt(cleaned.replace(/\D/g, ""), 10);
    return Number.isFinite(digits) ? digits : null;
  }
  const num = parseFloat(match[1]);
  const mult = { K: 1000, M: 1000000, B: 1000000000 };
  return Math.round(num * (mult[(match[2] || "").toUpperCase()] || 1));
}

function extractHashtags(text) {
  return [...String(text || "").matchAll(/#([\w\u00C0-\u024F]+)/gi)].map((m) => `#${m[1]}`);
}

function stripHashtags(text) {
  return String(text || "")
    .replace(/#[\w\u00C0-\u024F]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProduct(content) {
  const text = String(content?.text || "").trim();
  const hashtags = content?.hashtags || [];
  const shopHashtags = hashtags
    .map((h) => h.replace(/^#/, "").toLowerCase())
    .filter((h) => SHOP_HASHTAGS.has(h))
    .map((h) => `#${h}`);

  const links = content?.outboundLinks || [];
  const shopLink = links.find((l) =>
    /amazon\.|amzn\.|shop\.|etsy\.|shopify|linktr\.ee/i.test(l?.url || l || "")
  );

  const clean = stripHashtags(text);
  let product = null;
  let method = "caption_fallback";

  const lineMatch = clean.match(PRODUCT_LINE_RE);
  if (lineMatch?.[1]) {
    product = lineMatch[1].trim();
    method = "caption_pattern";
  } else if (shopLink) {
    product = typeof shopLink === "string" ? shopLink : shopLink.url;
    method = "shop_link";
  } else if (shopHashtags.length) {
    product = shopHashtags.join(" ");
    method = "shop_hashtags";
  } else if (clean.length) {
    product = clean.split(/[.!?]/)[0]?.trim().slice(0, 120) || clean.slice(0, 120);
    method = "caption_first_line";
  }

  return { product, extractionMethod: method, shopHashtags, shopLink: shopLink?.url || shopLink || null };
}

async function loadUrlsFromFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8").trim();
  let urls = [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.urls || parsed.posts || [];
    urls = list.map((item) => (typeof item === "string" ? item : item?.url)).filter(Boolean);
  } else {
    urls = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return urls
    .map((url) => normalizePostUrl(url))
    .filter(Boolean)
    .map((url) => ({ url, discoveryQuery: "urls-file", serpTitle: null, serpSnippet: null }));
}

async function dismissInstagramOverlays(page) {
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll("button")) {
      const t = btn.textContent.trim().toLowerCase();
      if (t.includes("not now") || t.includes("decline") || t === "accept") btn.click();
    }
  }).catch(() => {});
}

async function discoverFromHashtags(hashtags, targetPool, manager) {
  const seen = new Set();
  const discovered = [];
  let session;

  try {
    session = await manager.openSession({ engine: "camoufox", timeout: 45000 });
    const { page } = session;

    for (const tag of hashtags) {
      if (seen.size >= targetPool) break;
      const tagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
      console.log(`Browsing #${tag}...`);

      await page.goto(tagUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await dismissInstagramOverlays(page);
      await page.waitForTimeout(2500);

      for (let round = 0; round < 20 && seen.size < targetPool; round++) {
        const links = await page.evaluate(() =>
          [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
            .map((a) => a.href)
            .filter(Boolean)
        );

        for (const href of links) {
          const url = normalizePostUrl(href);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          discovered.push({
            url,
            discoveryQuery: `#${tag}`,
            serpTitle: null,
            serpSnippet: null,
          });
          if (seen.size >= targetPool) break;
        }

        await page.mouse.wheel(0, 900).catch(() => {});
        await page.waitForTimeout(1200);
      }
      console.log(`  → ${seen.size} unique post URLs after #${tag}`);
    }
  } catch (error) {
    console.warn(`Hashtag browse failed: ${error?.message || error}`);
  } finally {
    if (session) await session.close?.().catch(() => {});
  }

  return discovered;
}

async function discoverUrls(queries, searchLimit, targetPool) {
  const manager = new BrowserManager();
  const seen = new Set();
  const discovered = [];

  try {
    for (const query of queries) {
      if (seen.size >= targetPool) break;
      console.log(`Searching: "${query}" (limit ${searchLimit})...`);
      const result = await searchInstagram(
        query,
        { limit: searchLimit, format: "json" },
        manager
      );

      for (const row of result.results || []) {
        const url = normalizePostUrl(row.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        discovered.push({
          url,
          discoveryQuery: query,
          serpTitle: row.title || null,
          serpSnippet: row.snippet || null,
        });
      }
      console.log(`  → ${result.results?.length || 0} raw, ${seen.size} unique post URLs so far`);
    }
  } finally {
    await manager.close?.().catch(() => {});
  }

  return discovered;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapResponseToRecord(response, candidate) {
  const content = response.content;
  const hashtags = extractHashtags(content?.text || "");
  const { product, extractionMethod, shopHashtags, shopLink } = extractProduct({
    text: content?.text,
    hashtags,
    outboundLinks: content?.outboundLinks,
  });

  return {
    url: response.finalUrl || candidate.url,
    product,
    extractionMethod,
    entityType: content?.entityType || content?.platform?.pathType || null,
    likeCount: parseCountLabel(content?.stats?.likeCount),
    commentCount: parseCountLabel(content?.stats?.commentCount),
    caption: content?.text || "",
    hashtags,
    shopHashtags,
    shopLink,
    author: content?.author?.handle || content?.author?.name || null,
    publishedAt: content?.publishedAt || null,
    discoveryQuery: candidate.discoveryQuery,
    fetchError: null,
  };
}

async function enrichPosts(candidates, opts) {
  const enriched = [];
  let done = 0;

  for (let i = 0; i < candidates.length; i += opts.concurrency) {
    const batch = candidates.slice(i, i + opts.concurrency);
    const batchResults = await Promise.all(
      batch.map(async (candidate) => {
        try {
          const response = await fetchInstagramPost(null, candidate.url, { format: "json" });
          if (response.blocked || !response.content?.text) {
            return { ...candidate, fetchError: "blocked", likeCount: null, product: null };
          }
          return mapResponseToRecord(response, candidate);
        } catch (error) {
          return {
            ...candidate,
            fetchError: error?.message || String(error),
            likeCount: null,
            product: null,
          };
        }
      })
    );
    enriched.push(...batchResults);
    done += batch.length;
    if (done % 20 === 0 || done === candidates.length) {
      console.log(`Fetched metadata: ${done}/${candidates.length}`);
    }
    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  return enriched;
}

function rankTop(enriched, target) {
  const score = (row) =>
    Number.isFinite(row.likeCount) && row.likeCount > 0 ? row.likeCount : 0;

  const ranked = [...enriched].sort((a, b) => score(b) - score(a)).slice(0, target);
  return ranked.map((row, i) => ({
    rank: i + 1,
    url: row.url,
    product: row.product,
    entityType: row.entityType ?? null,
    likeCount: row.likeCount,
    commentCount: row.commentCount ?? null,
    hashtags: row.hashtags || [],
    shopHashtags: row.shopHashtags || [],
    shopLink: row.shopLink || null,
    author: row.author || null,
    publishedAt: row.publishedAt || null,
    caption: row.caption || "",
    extractionMethod: row.extractionMethod || null,
    discoveryQuery: row.discoveryQuery || null,
    fetchError: row.fetchError || null,
  }));
}

async function collectCandidates(opts, targetPool) {
  const seen = new Set();
  const merged = [];

  const addBatch = (batch) => {
    for (const item of batch) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      merged.push(item);
    }
  };

  if (opts.urlsFile) {
    console.log(`Loading URLs from ${opts.urlsFile}...`);
    addBatch(await loadUrlsFromFile(opts.urlsFile));
  }
  if (!opts.skipSearch && merged.length < targetPool) {
    addBatch(await discoverUrls(opts.queries, opts.searchLimit, targetPool));
  }
  if (!opts.skipHashtagBrowse && merged.length < targetPool) {
    const manager = new BrowserManager();
    try {
      addBatch(await discoverFromHashtags(DISCOVERY_HASHTAGS, targetPool, manager));
    } finally {
      await manager.close?.().catch(() => {});
    }
  }

  return merged;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { discoverPool, fetchPool } = computePools(opts.target);
  const runOpts = {
    ...opts,
    queries: opts.target <= 10 ? opts.queries.slice(0, 1) : opts.queries,
    searchLimit: opts.target <= 10 ? discoverPool : opts.searchLimit,
  };

  console.log(`Target: top ${opts.target} Instagram posts by like count`);
  console.log(`Will discover ~${discoverPool} URLs, fetch ~${fetchPool}, then rank`);
  console.log(`Output: ${opts.output}`);

  const discovered = await collectCandidates(runOpts, discoverPool);
  if (discovered.length === 0) {
    console.error("No Instagram post URLs found. Run: npx camoufox-js fetch");
    process.exit(1);
  }

  console.log(`Discovered ${discovered.length} unique post URLs`);

  if (opts.discoverOnly) {
    await fs.writeFile(
      opts.output,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: "discover-only",
          discoveredCount: discovered.length,
          urls: discovered.map((d) => d.url),
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`Wrote ${opts.output}`);
    return;
  }

  const pool = discovered.slice(0, fetchPool);
  console.log(`Fetching metadata for ${pool.length} posts (concurrency ${opts.concurrency})...`);
  const enriched = await enrichPosts(pool, opts);
  const posts = rankTop(enriched, opts.target);
  const withLikes = posts.filter((p) => p.likeCount > 0).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    description:
      "Top Instagram product-trend posts/reels by like count. Product from caption/heuristics.",
    platform: "instagram",
    targetCount: opts.target,
    discoveredCount: discovered.length,
    fetchedCount: enriched.length,
    rankedWithLikeCount: withLikes,
    searchQueries: runOpts.queries,
    posts,
  };

  await fs.mkdir(path.dirname(opts.output), { recursive: true });
  await fs.writeFile(opts.output, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Done. Ranked ${posts.length} posts (${withLikes} with like counts) → ${opts.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
