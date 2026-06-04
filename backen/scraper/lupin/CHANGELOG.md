# Changelog

## 0.2.0 (2026-05-07)

### Features

- Expanded Lupin from a page scraper into a broader scraping toolkit with `fetch`, `search`, `crawl`, `map`, `download`, `llm`, and `platform` CLI commands.
- Added built-in platform providers for web, Google, X/Twitter, Reddit, Hacker News, YouTube, Instagram, TikTok, and Polymarket.
- Added installable platform support so custom platform packages can be installed, enabled, disabled, removed, and exposed through the CLI and MCP server.
- Added site crawling and URL mapping with depth, limit, scope, include/exclude glob, sitemap, robots.txt, concurrency, delay, and file output options.
- Added MCP coverage for search, fetch, browser automation, crawl/map, and video download workflows.
- Added LLM extraction with local or OpenAI-compatible providers, including free-form prompts, JSON Schema output, provider management, and per-page crawl extraction.
- Added multimodal extraction support for platform posts where provider media is available.
- Added screenshot capture options for browser-backed fetches.
- Added video download support with optional `yt-dlp` and FFmpeg setup.
- Added proxy options for fetch, search, and crawl flows.

### Improvements

- Added runtime doctor/setup checks for HTTP, Camoufox, fallback browser, `yt-dlp`, and FFmpeg readiness.
- Added structured provider result shapes with warnings, snapshot dates, attempted-engine metadata, and clearer blocked/empty-result reporting.
- Improved adaptive search and fetch routing with provider-specific fallbacks, over-requesting, deduplication, and result sanitization.
- Improved browser session handling with explicit session lifecycle tools and safer default isolation.
- Improved documentation with CLI reference, configuration, platform, and LLM extraction guides.

### Packaging

- Include public `docs/*.md` files and `CHANGELOG.md` in the npm package.
- Keep local development documentation subfolders such as `docs/agents/` and `docs/superpowers/` out of the npm package.

## 0.1.0 (2026-03-25)

Initial public release.

### Features

- Three-stage adaptive scraping pipeline: HTTP → Camoufox → Patchright fallback
- Sticky domain memory to skip lower stages on known-difficult domains
- CLI with `--json`, `--engine`, `--wait-for`, `--timeout` flags
- MCP server via `--mcp` flag (stdio transport, `scrape_page` tool)
- CDP fallback provider for self-hosted browser backends
- Filesystem locks for safe concurrent profile access
- Cloudflare, DataDome, and generic challenge detection

### Engines

- `auto` — full pipeline with escalation
- `http` — plain HTTP fetch with TLS and system CA support
- `camoufox` — headless Firefox with anti-fingerprinting via camoufox-js
- `fallback` — persistent Chrome profile via Patchright or CDP
