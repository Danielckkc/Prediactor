#!/usr/bin/env node
/**
 * Collect TikTok product-trend posts, rank by view count, write JSON.
 *
 * Usage:
 *   node scripts/tiktok-product-trends.mjs
 *   node scripts/tiktok-product-trends.mjs --target 300 --output ./tiktok-trends.json
 *   node scripts/tiktok-product-trends.mjs --target 10 --discover-only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchTiktok } from "../src/providers/tiktok/search.js";
import { fetchTiktokPost } from "../src/providers/tiktok/fetch.js";
import { BrowserManager } from "../src/runtime/browser-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_QUERIES = [
  "tiktok shop viral product",
  "amazon finds must have",
  "tiktok made me buy it",
  "viral gadget review",
  "best tiktok product 2025",
  "tiktok shop bestseller",
  "underrated amazon find",
  "product review haul",
];

const DISCOVERY_HASHTAGS = [
  "tiktokmademebuyit",
  "amazonfinds",
  "tiktokshop",
  "viralproducts",
  "musthave",
  "tiktokshopfinds",
  "amazonmusthaves",
];

const SHOP_HASHTAGS = new Set([
  "tiktokmademebuyit",
  "tiktokshop",
  "amazonfinds",
  "amazonmusthaves",
  "tiktokshopfinds",
  "musthave",
  "viralproduct",
  "tiktokshopusa",
  "shopnow",
  "productreview",
  "giftideas",
]);

const PRODUCT_LINE_RE =
  /(?:this|the|my|got|buy|link for|link to|check out|obsessed with|game.?changer)\s+(.{4,80}?)(?:\.|!|\?|#|$)/i;

function parseArgs(argv) {
  const opts = {
    target: 300,
    output: path.join(ROOT, "tiktok-product-trends.json"),
    discoverOnly: false,
    concurrency: 4,
    searchLimit: 200,
    delayMs: 400,
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
      console.log(`Usage: node scripts/tiktok-product-trends.mjs [options]

Options:
  --target <n>        Top posts by view count (default: 300)
  --output <path>     JSON output path (default: ./tiktok-product-trends.json)
  --urls-file <path>  JSON/text file with TikTok video URLs (one per line or JSON array)
  --concurrency <n>   Parallel fetches (default: 4)
  --delay <ms>        Delay between fetch batches (default: 400)
  --search-limit <n>  URLs per search query, max 200 (default: 200)
  --skip-search       Skip SERP discovery (use hashtag browse and/or --urls-file)
  --skip-hashtag-browse  Skip TikTok hashtag page discovery
  --discover-only     Only collect URLs, skip metadata fetch
  -h, --help          Show this help

Requires browser for search/hashtag discovery: run "lupin setup" or "npx camoufox-js fetch" first.
`);
      process.exit(0);
    }
  }

  opts.target = Math.max(1, Math.min(opts.target, 500));
  opts.searchLimit = Math.max(10, Math.min(opts.searchLimit, 200));
  opts.concurrency = Math.max(1, Math.min(opts.concurrency, 12));
  return opts;
}

/** How many URLs to discover and fetch before ranking (scales down for small --target). */
function computePools(target) {
  if (target <= 10) {
    const fetchPool = target + 2;
    return { discoverPool: fetchPool, fetchPool };
  }
  const fetchPool = Math.min(target + 50, Math.ceil(target * 1.15));
  return { discoverPool: fetchPool, fetchPool };
}

function normalizeVideoUrl(url) {
  const match = String(url || "").match(/(https?:\/\/[^/]*tiktok\.com\/@[^/]+\/video\/\d+)/i);
  return match ? match[1] : null;
}

function stripHashtags(text) {
  return String(text || "")
    .replace(/#[\w\u00C0-\u024F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProduct(content) {
  const text = String(content?.text || "").trim();
  const hashtags = (content?.platform?.hashtags || []).map((h) =>
    h.replace(/^#/, "").toLowerCase()
  );
  const shopHashtags = hashtags.filter((h) => SHOP_HASHTAGS.has(h));

  const links = content?.outboundLinks || [];
  const shopLink = links.find((l) =>
    /tiktok\.com\/shop|amazon\.|amzn\.|shop\.|etsy\.|ebay\.|walmart\.|target\.com/i.test(l?.url || l || "")
  );

  const clean = stripHashtags(text);
  let product = null;
  let method = "caption_fallback";

  const lineMatch = clean.match(PRODUCT_LINE_RE);
  if (lineMatch?.[1]) {
    product = lineMatch[1].trim();
    method = "caption_pattern";
  }

  if (!product && shopLink) {
    product = typeof shopLink === "string" ? shopLink : shopLink.url;
    method = "shop_link";
  }

  if (!product && shopHashtags.length) {
    product = shopHashtags.map((h) => `#${h}`).join(" ");
    method = "shop_hashtags";
  }

  if (!product && clean.length) {
    const sentence = clean.split(/[.!?]/)[0]?.trim();
    product = (sentence || clean).slice(0, 120);
    method = "caption_first_line";
  }

  return {
    product: product || null,
    extractionMethod: method,
    shopHashtags: shopHashtags.map((h) => `#${h}`),
    shopLink: typeof shopLink === "string" ? shopLink : shopLink?.url || null,
  };
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
    .map((url) => normalizeVideoUrl(url))
    .filter(Boolean)
    .map((url) => ({ url, discoveryQuery: "urls-file", serpTitle: null, serpSnippet: null }));
}

async function dismissTiktokOverlays(page) {
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll("button")) {
      const t = btn.textContent.trim().toLowerCase();
      if (t === "decline optional cookies" || t === "got it" || t === "reject all") btn.click();
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

      const tagUrl = `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`;
      console.log(`Browsing hashtag #${tag}...`);

      await page.goto(tagUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await dismissTiktokOverlays(page);
      await page.waitForTimeout(2500);

      for (let round = 0; round < 25 && seen.size < targetPool; round++) {
        const links = await page.evaluate(() =>
          [...document.querySelectorAll('a[href*="/video/"]')]
            .map((a) => a.href)
            .filter(Boolean)
        );

        for (const href of links) {
          const url = normalizeVideoUrl(href);
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

      console.log(`  → ${seen.size} unique video URLs after #${tag}`);
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
      const result = await searchTiktok(
        query,
        { limit: searchLimit, format: "json" },
        manager
      );

      for (const row of result.results || []) {
        const url = normalizeVideoUrl(row.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        discovered.push({
          url,
          discoveryQuery: query,
          serpTitle: row.title || null,
          serpSnippet: row.snippet || null,
        });
      }

      console.log(`  → ${result.results?.length || 0} raw, ${seen.size} unique video URLs so far`);
      if (result.blocked) {
        console.warn(`  Warning: search may be blocked (${(result.warnings || []).join("; ")})`);
      }
    }
  } finally {
    await manager.close?.().catch(() => {});
  }

  return discovered;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function mapItemToRecord(item, finalUrl, candidate) {
  const hashtags = (item.textExtra || [])
    .filter((entry) => entry?.type === 1 && entry?.hashtagName)
    .map((entry) => `#${entry.hashtagName}`);
  const content = {
    text: String(item.desc || "").trim(),
    platform: { hashtags },
    outboundLinks: [],
    stats: {
      viewCount: item.stats?.playCount ?? null,
      likeCount: item.stats?.diggCount ?? null,
      commentCount: item.stats?.commentCount ?? null,
      shareCount: item.stats?.shareCount ?? null,
    },
    author: {
      handle: item.author?.uniqueId ? `@${item.author.uniqueId}` : null,
      name: item.author?.nickname || null,
    },
    publishedAt: item.createTime
      ? new Date(Number(item.createTime) * 1000).toISOString()
      : null,
  };
  const { product, extractionMethod, shopHashtags, shopLink } = extractProduct(content);
  return {
    url: finalUrl || candidate.url,
    product,
    extractionMethod,
    viewCount: content.stats.viewCount,
    likeCount: content.stats.likeCount,
    commentCount: content.stats.commentCount,
    shareCount: content.stats.shareCount,
    caption: content.text,
    hashtags,
    shopHashtags,
    shopLink,
    author: content.author.handle || content.author.name,
    publishedAt: content.publishedAt,
    discoveryQuery: candidate.discoveryQuery,
    fetchError: null,
  };
}

async function browserFetchPost(url, manager) {
  const session = await manager.openSession({ engine: "camoufox", timeout: 45000 });
  try {
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await dismissTiktokOverlays(session.page);
    await Promise.race([
      session.page.waitForFunction(
        () =>
          !!document.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__") ||
          !!document.querySelector('[data-e2e="like-count"]')
      ),
      session.page.waitForTimeout(8000),
    ]).catch(() => {});

    const payload = await session.page.evaluate(() => {
      const el = document.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el) return { hydration: null };
      try {
        return { hydration: JSON.parse(el.textContent) };
      } catch {
        return { hydration: null };
      }
    });

    const detail = payload?.hydration?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
    const item = detail?.itemInfo?.itemStruct;
    if (item && Number(detail?.statusCode) === 0) {
      return { blocked: false, item, finalUrl: session.page.url() };
    }

    const dom = await session.page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || "").trim() : "";
      };
      const desc =
        txt('[data-e2e="browse-video-desc"]') ||
        txt('[data-e2e="video-desc"]') ||
        "";
      const author =
        document.querySelector('a[href^="/@"]')?.textContent?.trim() || "";
      return {
        desc,
        author,
        likeCount: txt('[data-e2e="like-count"]'),
        commentCount: txt('[data-e2e="comment-count"]'),
        shareCount: txt('[data-e2e="share-count"]'),
      };
    });

    if (!dom.desc && !dom.likeCount) {
      return { blocked: true, item: null, finalUrl: session.page.url() };
    }

    return {
      blocked: false,
      item: {
        desc: dom.desc,
        author: { uniqueId: dom.author.replace(/^@/, ""), nickname: dom.author },
        stats: {
          playCount: null,
          diggCount: parseCountLabel(dom.likeCount),
          commentCount: parseCountLabel(dom.commentCount),
          shareCount: parseCountLabel(dom.shareCount),
        },
        textExtra: [],
        createTime: null,
      },
      finalUrl: session.page.url(),
    };
  } finally {
    await session.close?.().catch(() => {});
  }
}

async function enrichPosts(candidates, opts) {
  const manager = new BrowserManager();
  const enriched = [];
  let done = 0;

  try {
    const batches = [];
    for (let i = 0; i < candidates.length; i += opts.concurrency) {
      batches.push(candidates.slice(i, i + opts.concurrency));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          try {
            const response = await fetchTiktokPost(null, candidate.url, {
              format: "json",
              maxComments: 0,
            }, manager);

            if (!response.blocked && response.content?.text) {
              const content = response.content;
              const { product, extractionMethod, shopHashtags, shopLink } =
                extractProduct(content);
              return {
                url: response.finalUrl || candidate.url,
                product,
                extractionMethod,
                viewCount: content?.stats?.viewCount ?? null,
                likeCount: content?.stats?.likeCount ?? null,
                commentCount: content?.stats?.commentCount ?? null,
                shareCount: content?.stats?.shareCount ?? null,
                caption: content?.text || "",
                hashtags: content?.platform?.hashtags || [],
                shopHashtags,
                shopLink,
                author: content?.author?.handle || content?.author?.name || null,
                publishedAt: content?.publishedAt || null,
                discoveryQuery: candidate.discoveryQuery,
                fetchError: null,
              };
            }

            const browser = await browserFetchPost(candidate.url, manager);
            if (!browser.blocked && browser.item) {
              return mapItemToRecord(browser.item, browser.finalUrl, candidate);
            }

            return { ...candidate, fetchError: "blocked", viewCount: null, product: null };
          } catch (error) {
            return {
              ...candidate,
              fetchError: error?.message || String(error),
              viewCount: null,
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
  } finally {
    await manager.close?.().catch(() => {});
  }

  return enriched;
}

function rankTop(enriched, target) {
  const score = (row) => {
    if (Number.isFinite(row.viewCount) && row.viewCount > 0) return row.viewCount;
    if (Number.isFinite(row.likeCount) && row.likeCount > 0) return row.likeCount;
    return 0;
  };

  const withViews = enriched.filter((r) => score(r) > 0);
  const withoutViews = enriched.filter((r) => score(r) <= 0);

  withViews.sort((a, b) => score(b) - score(a));
  withoutViews.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));

  const ranked = [...withViews, ...withoutViews].slice(0, target);
  return ranked.map((row, i) => ({
    rank: i + 1,
    url: row.url,
    product: row.product,
    viewCount: row.viewCount,
    likeCount: row.likeCount ?? null,
    commentCount: row.commentCount ?? null,
    shareCount: row.shareCount ?? null,
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
    console.log(`  → ${merged.length} URLs from file`);
  }

  if (!opts.skipSearch && merged.length < targetPool) {
    addBatch(await discoverUrls(opts.queries, opts.searchLimit, targetPool));
  }

  if (!opts.skipHashtagBrowse && merged.length < targetPool) {
    const manager = new BrowserManager();
    try {
      addBatch(
        await discoverFromHashtags(DISCOVERY_HASHTAGS, targetPool, manager)
      );
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

  console.log(`Target: top ${opts.target} posts by view count`);
  console.log(`Will discover ~${discoverPool} URLs, fetch ~${fetchPool}, then rank`);
  console.log(`Output: ${opts.output}`);

  const discovered = await collectCandidates(runOpts, discoverPool);
  if (discovered.length === 0) {
    console.error(
      "No TikTok video URLs found.\n" +
        "  1. Run: lupin setup   (or: npx camoufox-js fetch)\n" +
        "  2. Retry this script, or pass --urls-file with your own URLs"
    );
    process.exit(1);
  }

  console.log(`Discovered ${discovered.length} unique video URLs`);

  if (opts.discoverOnly) {
    const payload = {
      generatedAt: new Date().toISOString(),
      mode: "discover-only",
      discoveredCount: discovered.length,
      urls: discovered.map((d) => d.url),
    };
    await fs.writeFile(opts.output, JSON.stringify(payload, null, 2), "utf8");
    console.log(`Wrote ${opts.output}`);
    return;
  }

  const pool = discovered.slice(0, fetchPool);
  console.log(`Fetching metadata for ${pool.length} posts (concurrency ${opts.concurrency})...`);

  const enriched = await enrichPosts(pool, opts);
  const posts = rankTop(enriched, opts.target);

  const withViews = posts.filter(
    (p) => (p.viewCount > 0) || (p.likeCount > 0)
  ).length;
  const payload = {
    generatedAt: new Date().toISOString(),
    description:
      "Top TikTok product-trend posts by view count. URLs from web search; product from caption/heuristics.",
    targetCount: opts.target,
    discoveredCount: discovered.length,
    fetchedCount: enriched.length,
    rankedWithViewCount: withViews,
    searchQueries: runOpts.queries,
    posts,
  };

  await fs.mkdir(path.dirname(opts.output), { recursive: true });
  await fs.writeFile(opts.output, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Done. Ranked ${posts.length} posts (${withViews} with view counts) → ${opts.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
