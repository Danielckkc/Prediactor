#!/usr/bin/env node

import { version } from "../src/version.js";

function hasFlag(args, name) {
  return args.includes(name);
}

const argv = process.argv.slice(2);

if (hasFlag(argv, "--version")) {
  console.log(version);
  process.exit(0);
}

if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
  console.log(`lupin v${version}

Adaptive web scraper with HTTP-first routing, Camoufox escalation, and Patchright fallback.

Usage:
  lupin setup [--with-video]
  lupin doctor [--json]
  lupin update check [--json]
  lupin fetch <platform> <url> [options]
  lupin search <platform> <query> [options]
  lupin download <url> [options]
  lupin crawl <url> [options]
  lupin map <url> [options]
  lupin llm <add|list|remove|default>
  lupin platform <list|install|remove|enable|disable|update|doctor>
  lupin --mcp

Commands:
  setup                    Install browser assets
    --with-video             Also install yt-dlp + FFmpeg for video downloads
  doctor                   Inspect runtime/browser readiness
  update check             Check whether a newer lupin-cli release is available
  fetch <platform> <url>   Fetch structured data from a URL
  search <platform> <query>  Search a platform
  download <url>           Download a video to a local file (requires setup --with-video)
  crawl <url>              Crawl a site and extract content from each page
  map <url>                Discover all URLs on a site (no content extraction)
  llm <action>             Manage LLM providers for extraction
  platform <action>        Manage installable platform providers

Fetch platforms:
  page + currently enabled platform providers (see: lupin platform list)

Search platforms:
  web, google + currently enabled platform providers (see: lupin platform list)

Fetch options:
  --format <fmt>        Output format: json (default), markdown, html
  --json                Alias for --format json
  --engine <engine>     Engine: auto, http, camoufox, fallback (aliases: fast=http, patchright=fallback)
  --wait-for <selector> CSS selector to wait for before extraction
  --timeout <ms>        Timeout in milliseconds
  --max-comments <n>    Max comments to return (for providers that support comments)
  --max-replies <n>     Max replies per comment (default: 1)
  --min-comment-likes <n> Minimum likes for a comment to be included (default: 0)

Screenshot options (fetch only, requires browser engine):
  --screenshot              Capture a screenshot after page load
  --screenshot-full-page    Capture full scrollable height instead of viewport
  --screenshot-format <fmt> Image format: png (default), jpeg
  --screenshot-quality <n>  JPEG quality 0-100 (default 80, ignored for png)
  --screenshot-to <path>    Output file path (default: screenshot.png or .jpg)

Search options:
  --format <fmt>        Output format: json (default), markdown
  --json                Alias for --format json
  --limit <n>           Max number of results (default: 10)
  --sort <order>        Sort order: relevance (default), recent
  --date-from <date>    Start date filter (YYYY-MM-DD)
  --date-to <date>      End date filter (YYYY-MM-DD)
  --site <domain>       Restrict results to this domain
  --engine <engine>     Explicit search engine override

Download options:
  --output-dir <dir>    Directory to save the file (default: current directory)
  --audio-only          Extract audio only as MP3
  --subtitles           Download subtitles if available
  --format <fmt>        Output format: json (default)

Crawl options:
  --depth <N>             Max crawl depth (default: 3)
  --limit <N>             Max pages to crawl (default: 100)
  --scope <strategy>      Scope strategy (default: same-hostname)
  --include <globs>       Comma-separated include globs
  --exclude <globs>       Comma-separated exclude globs
  --concurrency <N>       Parallel requests (default: 3)
  --delay <seconds>       Delay between requests
  --engine <name>         Scraping engine (default: auto)
  --format <fmt>          Output format: json, markdown, html
  -o, --output <file>     Write output to file
  --from <file>           Read URLs from file (one per line) instead of crawling
  --ignore-query-params   Treat URLs with different query params as same
  --ignore-robots         Ignore robots.txt rules
  --no-sitemap            Skip sitemap discovery

Map options:
  --depth <N>             Max crawl depth (default: 3)
  --limit <N>             Max URLs to discover (default: 500)
  --scope <strategy>      Scope strategy (default: same-hostname)
  --include <globs>       Comma-separated include globs
  --exclude <globs>       Comma-separated exclude globs
  --delay <seconds>       Delay between requests
  -o, --output <file>     Write output to file
  --ignore-query-params   Treat URLs with different query params as same
  --ignore-robots         Ignore robots.txt rules
  --no-sitemap            Skip sitemap discovery

LLM extraction (fetch and crawl):
  --extract <prompt>      Natural-language extraction prompt
  --schema <json|file>    JSON Schema for structured extraction output
  --llm <provider>        LLM provider name (see: lupin llm list)
  --llm-timeout <ms>      LLM inference timeout

LLM provider management:
  lupin llm add <name> --base-url <url> --model <model> [--api-key <key>] [--default]
  lupin llm list           Show configured providers
  lupin llm remove <name>  Remove a provider
  lupin llm default <name> Set the default provider

Platform management:
  lupin platform list
  lupin platform install <path|package>
  lupin platform update <name>
  lupin platform update --all
  lupin platform doctor <name>
  lupin platform doctor --all --smoke
  lupin platform remove <name>
  lupin platform enable <name>
  lupin platform disable <name>

Proxy options (fetch, search, crawl):
  --proxy <url>           Proxy URL (e.g. http://host:port or socks5://host:port)
  --proxy-list <file>     File with one proxy per line, or comma-separated inline list
  --proxy-rotate <strategy>  Rotation strategy for proxy list

Doctor options:
  --json                Output doctor report as JSON
  --no-update-check     Skip npm registry update check

Update options:
  --json                Output update check as JSON

Global options:
  --mcp                 Start as MCP server (stdio transport)
  --version             Show version number
  --help, -h            Show this help

Examples:
  lupin setup
  lupin setup --with-video
  lupin doctor --json
  lupin update check
  lupin fetch https://example.com
  lupin fetch page https://example.com --format markdown
  lupin fetch reddit https://reddit.com/r/node/comments/abc --max-comments 20
  lupin fetch youtube https://youtube.com/watch?v=dQw4w9WgXcQ
  lupin search web "rust async runtime" --limit 5
  lupin search reddit "best keyboards" --sort recent
  lupin search hn "LLM agents" --limit 20
  lupin download https://youtube.com/watch?v=dQw4w9WgXcQ
  lupin download https://tiktok.com/@user/video/123 --audio-only
  lupin crawl https://docs.example.com --depth 2 --limit 50 --format markdown
  lupin crawl https://example.com --extract "extract product names and prices" --llm ollama
  lupin crawl --from urls.txt -o results.json
  lupin map https://example.com --limit 1000 -o sitemap.txt
  lupin llm add openai --base-url https://api.openai.com/v1 --model gpt-4o --api-key sk-... --default
  lupin llm list
  lupin platform list
  lupin platform update --all
  lupin platform disable instagram
  lupin platform install ./my-lupin-platform
  lupin fetch https://example.com --extract "summarize this page" --llm openai
  lupin fetch https://example.com --screenshot --screenshot-to out.png
  lupin fetch https://example.com --screenshot --screenshot-format jpeg --screenshot-quality 60
  lupin fetch https://example.com --proxy socks5://127.0.0.1:1080`);
  process.exit(0);
}

if (hasFlag(argv, "--mcp")) {
  const { startMcpServer } = await import("../src/mcp-server.js");
  await startMcpServer();
} else {
  const { runCli } = await import("../src/cli.js");
  await runCli(argv);
}
