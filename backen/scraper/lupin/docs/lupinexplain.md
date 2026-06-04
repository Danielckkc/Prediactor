# Lupin — Explained

> One document merging the original **README** and **PRODUCT-TRENDS** guides.

_Prediactor note: to actually run the scraper, use `backen/scraper/scraper.py` — it wraps this engine._

---

# Part 1 — Lupin Overview (from README)

<div>
  <img width="972" height="480" alt="lupin_cut2_demo_480p" src="https://github.com/user-attachments/assets/5d969676-3a94-4ab6-9ee0-3c46780b1ec6" />
</div>

<div>
  <h1 align="center">Lupin</h1>
  <p align="center">
  <strong>Adaptive web scraper that automatically changes its strategy (HTTP + stealth browsers) to scrape the pages you need. Bypass most current anti-bot protections.</strong><br />
  Crawl, markdown & JSON output, LLM extraction, built-in web search & social media scrapers, CLI, Library and MCP for AI agents.
  </p>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/lupin-cli">
    <img alt="npm" src="https://img.shields.io/npm/v/lupin-cli?color=cb0000" />
  </a>
  <a href="LICENSE">
    <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" />
  </a>
  <a href="https://nodejs.org/">
    <img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-339933.svg?logo=node.js&logoColor=white" />
  </a>
</p>

```bash
npm install -g lupin-cli
lupin setup
lupin fetch https://www.nytimes.com/ --format markdown
```

[Why Lupin](#why-lupin) · [Comparison](#comparison) · [Benchmark](#benchmark) · [Platforms](#platforms) · [MCP for AI Agents](#mcp--ai-agents) · [Docs](#docs)

---

## Why Lupin?

Most web pages don't need a stealth browser. But when they do, you shouldn't have to figure that out yourself.
Sometimes, your scraping pipeline works with plain HTTP 10 times in a row, but then fails the 11th time. Lupin solves that issue by implementing smart escalation.

```
HTTP (fast, ~0.2s) ──→ Blocked ? ──→ Camoufox (stealth Firefox) ──→ Blocked ? ──→ Patchright (stealth Chrome)
```

Lupin starts with a plain HTTP request. If the response looks blocked (Cloudflare challenge, empty body, bot detection page), it automatically escalates to two heavily patched stealth browsers: Camoufox, an anti-fingerprint Firefox fork, and Patchright, a patched Chromium that passes every major bot detector. Having two different engines (selected for their efficiency) maintained by two different teams diminishes the risk of watching your request suddenly get blocked on all engines.

**Domains that needed escalation are remembered with their engine.** Next time, Lupin skips straight to the engine that worked (24h sticky memory). Over time, your scraping gets faster automatically.

This matters because:

- Most of your requests will go through HTTP, saving 10-20x time and bandwidth compared to a headless browser
- Only when exhausted or picking a hard domain, your requests will use a stealth browser
- This means: faster, a bit more reliable scraping and less egress/proxy costs for all your projects

---

## Benchmark

Benchmark as of 2026-04-07, on 25 real-world targets considered hard.
These results are **not** definitive, anti-bot protections evolve all the time and one website that was crawlable one day may become blocked tomorrow.

| Site            | Lupin     | Crawlee   | Scrapling | Crawl4AI  | Exa MCP   | Claude Code fetch() |
| --------------- | --------- | --------- | --------- | --------- | --------- | ------------------- |
| Reuters         | ✅        | ✅        | ❌        | ❌        | ✅        | ❌                  |
| Bloomberg       | ✅        | ❌        | ✅        | ❌        | ✅        | ❌                  |
| NY Times        | ✅        | ❌        | ✅        | ❌        | ❌        | ❌                  |
| Booking.com     | ✅        | ✅        | ❌        | ❌        | ❌        | ❌                  |
| Zillow          | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| TikTok          | ✅        | ✅        | ❌        | ❌        | ❌        | ❌                  |
| Indeed          | ✅        | ✅        | ✅        | ✅        | ✅        | ❌                  |
| ScienceDirect   | ✅        | ✅        | ✅        | ✅        | —         | —                   |
| Reddit          | ✅        | ✅        | ✅        | ✅        | ✅        | ❌                  |
| Instagram       | ✅        | ✅        | ✅        | ✅        | ❌        | ❌                  |
| YouTube         | ✅        | ✅        | ✅        | ✅        | ❌        | ❌                  |
| X.com           | ✅        | ✅        | ✅        | ❌        | ❌        | ❌                  |
| Pinterest       | ✅        | ✅        | ✅        | ✅        | ❌        | ❌                  |
| Amazon          | ✅        | ✅        | ✅        | ✅        | ✅        | ❌                  |
| LinkedIn        | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| Washington Post | ✅        | ✅        | ✅        | ✅        | ✅        | ❌                  |
| Medium          | ✅        | ❌        | ✅        | ✅        | ✅        | ✅                  |
| Cloudflare      | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| Polymarket      | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| Airbnb          | ✅        | ✅        | ✅        | ✅        | ✅        | ❌                  |
| eBay            | ✅        | ✅        | ❌        | ✅        | ✅        | ❌                  |
| ArXiv           | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| Wikipedia       | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| Craigslist      | ✅        | ✅        | ✅        | ✅        | —         | —                   |
| example.com     | ✅        | ✅        | ✅        | ✅        | ✅        | ✅                  |
| **Score**       | **25/25** | **22/25** | **21/25** | **19/25** | **17/23** | **7/23**            |

> Benchmark run 2026-04-07. Crawlee uses PlaywrightCrawler, Scrapling uses curl_cffi (HTTP-only), Claude Code uses the native fetch web function, Crawl4AI uses Playwright via patchright. Exa MCP and CC fetch tested on 23 of 25 URLs (— = not tested). Please note that in our tests, some heavily protected websites still fail after 4-5 consecutive attempts; these websites need either proxy rotation or more custom fingerprinting.

---

## Built-in web search

Lupin provides built-in web search as a convenience (supporting DuckDuckGo and Google as engines), DuckDuckGo is the default engine and the most reliable in our tests.

```bash
# Search the web (default engine: DuckDuckGo)
lupin search web "best open source web scraping tools" --limit 10

# Search a specific site with most recent results first and in markdown format
lupin search web "agent memory" --site docs.anthropic.com --sort recent --format markdown
```

---

## Popular social media platforms

Lupin provides built-in scrapers for the 8 most popular social platforms, using web search as a source for links. No API keys and no cookie exports required.

```bash
lupin search x "from:elonmusk AI" --limit 5
lupin search tiktok "productivity hacks" --limit 10
lupin search instagram "street photography" --limit 5
lupin fetch reddit https://reddit.com/r/node/comments/abc --max-comments 20
```

| Platform     | Search | Fetch | Method             |
| ------------ | ------ | ----- | ------------------ |
| Web / Google | ✅     | ✅    | Browser            |
| X / Twitter  | ✅     | ✅    | Browser            |
| Reddit       | ✅     | ✅    | HTTP only          |
| Hacker News  | ✅     | ✅    | HTTP only          |
| YouTube      | ✅     | ✅    | HTTP only          |
| Instagram    | ✅     | ✅    | Browser for search |
| TikTok       | ✅     | ✅    | Browser for search |
| Polymarket   | ✅     | ✅    | HTTP only          |

Platform scrapers are provided as a convenience. You can install/uninstall them at any time. Please note that scrapers for popular platforms often change and require updates (see below). Need a site that isn't built in? You can build your own installable platform package. See the [custom platform guide](docs/platforms.md).

### Platform updates and health checks

Social sites change often. Lupin separates platform health from core scraping so you can see what is installed, check whether a provider still works, and update platform packages when fixes ship.

```bash
# Show installed platforms, source, status, and version
lupin platform list

# Check whether Lupin core or platform packages have updates
lupin update check
lupin platform update --check

# Run manifest/tool checks for every platform
lupin platform doctor --all

# Run live smoke checks against known public targets
lupin platform doctor --all --smoke
```

---

## Quick start

```bash
npm install -g lupin-cli
lupin setup               # installs browser engines
lupin setup --with-video  # adds yt-dlp + FFmpeg for video download
lupin doctor              # shows what's ready
```

```bash
# Scrape any page
lupin fetch https://example.com

# Output as markdown (for LLMs, RAG pipelines)
lupin fetch https://example.com --format markdown

# Output as JSON (for scripts/crawl)
lupin fetch https://example.com --format json

# Output as HTML (for scripts/crawl)
lupin fetch https://example.com --format html

# Search the web
lupin search web "best web scraping library 2026"

# Crawl an entire site
lupin crawl https://docs.example.com --depth 2 --limit 50 --format markdown -o docs.jsonl

# Extract structured data with an LLM
lupin fetch https://example.com --schema '{"type":"object","properties":{"title":{"type":"string"}}}'

# Download YT/TikTok/Instagram video content
lupin download https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### Docker

```bash
docker build -t lupin .
docker run --rm -i lupin fetch https://example.com
docker run --rm -i lupin --mcp
```

HTTP-only flows (`fetch` in auto mode, `search reddit`, `search hn`, `search youtube`) work before browser setup.

---

## Using in AI Agents

We recommend that your agents use Lupin as a CLI or as an MCP server. Both let your agents scrape, search, browse and crawl.

### CLI Setup (recommended, less token usage, similar features)

**Claude Code / Codex / OpenCode / Hermes / OpenClaw**: add instructions to your `AGENTS.md`:

```text
## Web Scraping

This project uses `lupin-cli` for web scraping. Run `lupin --help` for full usage.

Common commands:
- `lupin fetch ` — scrape any page (returns JSON with text, title, status)
- `lupin fetch  --format markdown` — get clean LLM-ready markdown
- `lupin search web "query"` — web search
- `lupin search x "query"` — search X/Twitter without API keys
- `lupin search reddit "query"` — search Reddit
```

This setup uses ~90% fewer tokens than the MCP server and works with any agent that can run shell commands.

### MCP Setup

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lupin": {
      "command": "npx",
      "args": ["lupin-cli", "--mcp"]
    }
  }
}
```

**Cursor / other MCP clients:**

```json
{
  "command": "npx",
  "args": ["lupin-cli", "--mcp"]
}
```

### Available tools in MCP

| Category         | Tools                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search** (9)   | `search_web`, `search_google`, `search_x`, `search_reddit`, `search_hn`, `search_youtube`, `search_polymarket`, `search_instagram`, `search_tiktok`                                                                  |
| **Fetch** (10)   | `fetch_page`, `fetch_x_post`, `fetch_reddit_post`, `fetch_hn_item`, `fetch_polymarket_market`, `fetch_youtube_video`, `fetch_instagram_post`, `fetch_instagram_profile`, `fetch_tiktok_post`, `fetch_tiktok_profile` |
| **Browser** (10) | `browser_open_session`, `browser_navigate`, `browser_click`, `browser_type`, `browser_press`, `browser_wait_for`, `browser_snapshot`, `browser_extract`, `browser_screenshot`, `browser_close_session`               |
| **Site** (2)     | `crawl_site`, `map_site`                                                                                                                                                                                             |
| **Video** (1)    | `download_video` (requires `lupin setup --with-video`)                                                                                                                                                               |

---

## Use as a Library

```js
import { Lupin } from "lupin-cli";

const scraper = new Lupin();

try {
  const result = await scraper.scrape("https://example.com");
  console.log(result.engine, result.confidence, result.text.slice(0, 300));
} finally {
  await scraper.close();
}
```

One-shot convenience:

```js
import { scrapePage } from "lupin-cli";

const result = await scrapePage("https://example.com", { engine: "auto" });
```

---

## LLM summarization and structured schemas

Like Firecrawl and modern solutions, Lupin provides the possibility to wire in an LLM to retrieve structured data from any page using any LLM (Ollama or OpenAI-compatible endpoint) and return content as summarized markdown or structured JSON.

```bash
# Free-form extraction
lupin fetch <url> --extract "what are the prices?"

# Structured extraction with JSON Schema
lupin fetch <url> --schema '{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}}}'

# Multimodal: analyze images and video from platform posts
lupin fetch instagram <url> --extract "what brands are visible in the image?"
lupin fetch youtube <url> --extract "list the products shown in this video"
lupin fetch tiktok <url> --schema '{"type":"object","properties":{"products_shown":{"type":"array","items":{"type":"string"}}}}'

# Text-only extraction on any platform
lupin fetch reddit <url> --extract "summarize the top comments"

# Per-page extraction during crawls
lupin crawl https://docs.example.com --extract "summarize" --llm ollama
```

<i>For platform providers (Instagram, TikTok, YouTube, X), the model receives the actual images and video alongside text, not just metadata. You can ask about what's _in_ a photo or video, not just what the caption says.</i>

### Recommended setup: Ollama (free, local LLM, zero API keys. Requires 2-4GB of VRAM)

```bash
ollama pull qwen3.5:4b
lupin llm add ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b --default
```

### Alternative: OpenAI / OpenRouter-like endpoint

```bash
export OPENROUTER_API_KEY=sk-or-...

lupin llm add openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --api-key '${OPENROUTER_API_KEY}' \
  --model qwen/qwen3.5-9b \
  --default
```

Also supports any OpenAI-compatible endpoint. See [LLM extraction docs](docs/llm-extraction.md) for all options.

---

## Video, audio & social content download

Lupin can download video or audio from YouTube, TikTok, Instagram, and [1000+ other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) by installing [yt-dlp](https://github.com/yt-dlp/yt-dlp) as a dependency.

```bash
lupin setup --with-video                                    # one-time setup
lupin download https://www.youtube.com/watch?v=dQw4w9WgXcQ  # video as MP4
lupin download <url> --audio-only                            # extract MP3
lupin download <url> --subtitles                             # grab subs too
```

Content is downloaded temporarily into `~/.lupin/`; yt-dlp will auto-update on each run.

---

## Proxy Support

Lupin can route `fetch`, `search`, and `crawl` traffic through a single proxy or a rotating proxy list.

```bash
lupin fetch https://example.com --proxy socks5://127.0.0.1:1080
lupin search web "agentic AI" --proxy http://user:pass@host:port
lupin crawl https://example.com --proxy-list proxies.txt --proxy-rotate sticky-domain
```

---

## Docs

| Document                               | Description                                           |
| -------------------------------------- | ----------------------------------------------------- |
| [CLI Reference](docs/cli-reference.md) | Full flag reference for every command                 |
| [Configuration](docs/configuration.md) | Environment variables, result schemas, engine routing |
| [Custom Platforms](docs/platforms.md)  | Build, install, and share your own Lupin platforms    |

---

## Tests

```bash
npm test           # local/fixture suite
npm run test:live  # public-site verification
npm run test:all   # both
```

## License

[MIT](LICENSE)


---

# Part 2 — Product Trends: TikTok + Instagram (from PRODUCT-TRENDS)

# TikTok & Instagram product trends

Collect **300 posts per platform** (URL, product guess, stats), rank by popularity, save JSON. Built on [Lupin](https://github.com/vnguyen42/lupin) with Camoufox when sites block plain HTTP.

| Platform | Script |
|----------|--------|
| TikTok | `scripts/tiktok-product-trends.mjs` |
| Instagram | `scripts/instagram-product-trends.mjs` |

**Nightly (2 AM):** one job runs **TikTok first**, then **Instagram** when TikTok finishes.

---

## What you get

### TikTok

| Field | Description |
|-------|-------------|
| `url` | Video link |
| `product` | Guess from caption / shop hashtags |
| `viewCount` | Plays (primary rank) |
| `likeCount` | Fallback rank if views missing |

Ranked by **views**, then **likes**.

### Instagram

| Field | Description |
|-------|-------------|
| `url` | Post or reel (`/p/` or `/reel/`) |
| `product` | Guess from caption / hashtags |
| `likeCount` | Primary rank (views rarely in public meta) |
| `entityType` | `post` or `reel` |

Ranked by **likes**.

### Where files are saved

| How you run | TikTok | Instagram | Overwrites? |
|-------------|--------|-------------|-------------|
| Manual | `tiktok-product-trends.json` | `instagram-product-trends.json` | Yes (same path) |
| Daily 2 AM job | `data/tiktok-product-trends-YYYY-MM-DD.json` | `data/instagram-product-trends-YYYY-MM-DD.json` | No — new file per day per platform |

---

## 1. One-time setup

```powershell
cd c:\Users\lsu22\Downloads\lupin-main\lupin-main
npm install
npx camoufox-js fetch
```

Or: `npm run setup` · Requires **Node.js 18+**.

---

## 2. Quick test (3 posts each, ~2 minutes)

**TikTok**

```powershell
node scripts/tiktok-product-trends.mjs --target 3 --output ./tiktok-sample-3.json --skip-hashtag-browse
```

**Instagram**

```powershell
node scripts/instagram-product-trends.mjs --target 3 --output ./instagram-sample-3.json --skip-hashtag-browse
```

You want `viewCount` / `likeCount` filled in — not only `"fetchError": "blocked"`. See [Troubleshooting](#8-troubleshooting).

---

## 3. Scrape 300 TikTok posts

```powershell
node scripts/tiktok-product-trends.mjs --target 300 --output ./tiktok-product-trends.json
```

Or: `npm run tiktok:trends`

1. Discover URLs (web search + hashtags)  
2. Fetch ~350 posts  
3. Rank by views (then likes)  
4. Save top 300  

**Time:** ~45 min–2 hr · Safer if blocked: `--concurrency 2 --delay 800`

---

## 4. Scrape 300 Instagram posts

```powershell
node scripts/instagram-product-trends.mjs --target 300 --output ./instagram-product-trends.json
```

Or: `npm run instagram:trends`

Same flow as TikTok; ranked by **like count**. **Time:** ~45 min–2 hr.

---

## 5. Command options

### TikTok

| Option | Default | Meaning |
|--------|---------|---------|
| `--target` | `300` | Top posts in JSON (max 500) |
| `--output` | `./tiktok-product-trends.json` | Output path |
| `--concurrency` | `4` | Parallel fetches (1–12) |
| `--delay` | `400` | Ms between batches |
| `--search-limit` | `200` | URLs per search query |
| `--urls-file` | — | Your own video URLs |
| `--skip-search` | off | Hashtag browse + urls-file only |
| `--skip-hashtag-browse` | off | Search + urls-file only |
| `--discover-only` | off | URLs only, no fetch |

### Instagram

Same flags; default output is `./instagram-product-trends.json`.

Help: `node scripts/tiktok-product-trends.mjs --help` or `node scripts/instagram-product-trends.mjs --help`

---

## 6. Your own URL list

One URL per line (or JSON array):

```text
https://www.tiktok.com/@user/video/1234567890
https://www.instagram.com/p/ABC123/
https://www.instagram.com/reel/XYZ789/
```

**TikTok**

```powershell
node scripts/tiktok-product-trends.mjs --target 300 --urls-file ./my-urls.txt --skip-search --skip-hashtag-browse
```

**Instagram**

```powershell
node scripts/instagram-product-trends.mjs --target 300 --urls-file ./my-urls.txt --skip-search --skip-hashtag-browse
```

Need **≥300 URLs** per platform for a full ranked list.

---

## 7. JSON output

**TikTok** — `rankedWithViewCount`, `posts[].viewCount`, `posts[].product`, `posts[].hashtags`

**Instagram** — `rankedWithLikeCount`, `posts[].likeCount`, `posts[].entityType`, `posts[].product`

Use `posts[].product` and hashtags to spot trends in Excel, Python, etc.

---

## 8. Troubleshooting

### `"fetchError": "blocked"` (TikTok or Instagram)

1. `npx camoufox-js fetch`  
2. `--concurrency 2 --delay 1000`  
3. Retry later or different network  
4. Single-post test:
   ```powershell
   node ./bin/lupin.js fetch tiktok "https://www.tiktok.com/@scout2015/video/6718335390845095173" --format json
   node ./bin/lupin.js fetch instagram "https://www.instagram.com/p/DUqM9L0CCE5/" --format json
   ```

### No URLs found

Run `npx camoufox-js fetch`, or use `--urls-file`.

### Very slow

Normal for 300 posts per platform. Lower concurrency if blocked.

### TikTok: `rankedWithViewCount` is 0

Ranking fell back to **likes** — common when TikTok hides view counts.

---

## 9. Legal

- Respect [TikTok](https://www.tiktok.com/legal/terms-of-service) and [Instagram](https://help.instagram.com/) terms.  
- Personal / research use on **public** content only.  
- Prefer official APIs for production apps.

---

## 10. Automatic schedule — 2:00 AM daily (TikTok → Instagram)

One Windows task, no separate Instagram time.

| Step | Output |
|------|--------|
| 1. TikTok 300 | `data/tiktok-product-trends-YYYY-MM-DD.json` |
| 2. Instagram 300 | `data/instagram-product-trends-YYYY-MM-DD.json` |

Logs: `logs/social-trends-YYYY-MM-DD.log` (combined), plus per-platform logs in `logs/`.

### Install once

```powershell
cd c:\Users\lsu22\Downloads\lupin-main\lupin-main
.\scripts\install-daily-schedule.ps1
```

Task: **Lupin-Social-Product-Trends** · Removes old split tasks if present.

### Test full chain now

```powershell
.\scripts\run-social-trends-daily.ps1
```

Expect **~1.5–4 hours** for both platforms.

| Script | Purpose |
|--------|---------|
| `run-social-trends-daily.ps1` | TikTok → Instagram |
| `run-tiktok-trends-daily.ps1` | TikTok only |
| `run-instagram-trends-daily.ps1` | Instagram only |

### Requirements

- PC **on** around 2 AM  
- Node on **PATH**  
- `npx camoufox-js fetch` done once  
- Internet available  

### Change time

`taskschd.msc` → **Lupin-Social-Product-Trends** → Triggers → Edit  
Or change `-At "2:00AM"` in `scripts/install-daily-schedule.ps1` and reinstall.

### Remove schedule

```powershell
schtasks /Delete /TN "Lupin-Social-Product-Trends" /F
```

---

## 11. Cheat sheet

```powershell
cd c:\Users\lsu22\Downloads\lupin-main\lupin-main
npm install
npx camoufox-js fetch

# Quick tests
node scripts/tiktok-product-trends.mjs --target 3 --output ./tiktok-sample-3.json --skip-hashtag-browse
node scripts/instagram-product-trends.mjs --target 3 --output ./instagram-sample-3.json --skip-hashtag-browse

# Manual 300 each
node scripts/tiktok-product-trends.mjs --target 300 --output ./tiktok-product-trends.json
node scripts/instagram-product-trends.mjs --target 300 --output ./instagram-product-trends.json

# Nightly: install + test
.\scripts\install-daily-schedule.ps1
.\scripts\run-social-trends-daily.ps1
schtasks /Delete /TN "Lupin-Social-Product-Trends" /F
```
