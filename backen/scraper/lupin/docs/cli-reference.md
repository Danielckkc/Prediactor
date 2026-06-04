# CLI Reference

## fetch

Scrape a single URL. Lupin auto-detects the best engine unless overridden.

```bash
lupin fetch <url>                              # generic page, default as JSON
lupin fetch <url> --format markdown            # output as markdown
lupin fetch x <url>                            # X/Twitter post
lupin fetch reddit <url> --max-comments 20     # Reddit thread
lupin fetch youtube <url>                      # YouTube video
lupin fetch hn <url>                           # Hacker News item
lupin fetch <url> --screenshot                 # capture a 1920x1080 screenshot
lupin fetch <url> --screenshot --screenshot-to out.png
lupin fetch <url> --screenshot --screenshot-format jpeg --screenshot-quality 60
lupin fetch <url> --proxy user:pass@host:port     # single proxy
lupin fetch <url> --proxy-list proxies.txt        # rotate through proxy list
lupin fetch <url> --extract "summarize"           # LLM extraction
lupin fetch <url> --schema '{"type":"object"}'    # structured LLM extraction
```

Platforms: `page`, `x`, `reddit`, `hn`, `youtube`, `instagram`, `instagram-profile`, `tiktok`, `tiktok-profile`, `polymarket`

| Flag                        | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `--format <fmt>`            | `json` (default), `markdown`, `html`                     |
| `--engine <engine>`         | `auto`, `http`, `camoufox`, `fallback`                   |
| `--wait-for <selector>`     | CSS selector to wait for before extraction               |
| `--timeout <ms>`            | Timeout in milliseconds                                  |
| `--max-comments <n>`        | Max comments (for providers that support them)           |
| `--screenshot`              | Capture a 1920x1080 screenshot after page load           |
| `--screenshot-full-page`    | Capture full scrollable height instead of viewport       |
| `--screenshot-format <fmt>` | `png` (default) or `jpeg`                                |
| `--screenshot-quality <n>`  | JPEG quality 0-100 (default 80)                          |
| `--screenshot-to <path>`    | Output file path (default: `{domain}-{timestamp}.{ext}`) |
| `--extract <prompt>`        | Free-form LLM extraction prompt                          |
| `--schema <json\|file>`     | JSON Schema for structured LLM extraction                |
| `--llm <provider>`          | LLM provider name (uses default from config)             |
| `--llm-timeout <ms>`        | LLM inference timeout (default: 180000)                  |
| `--proxy <url>`             | Single proxy (`user:pass@host:port` or full URL)         |
| `--proxy-list <file\|list>` | Proxy list file or comma-separated URLs                  |
| `--proxy-rotate <strategy>` | `round-robin` (default), `random`, `sticky-domain`       |

## search

Search across platforms without API keys.

```bash
lupin search web "query"                       # web search
lupin search x "from:user topic" --limit 5     # X/Twitter
lupin search reddit "query" --sort recent       # Reddit
lupin search hn "query" --limit 20              # Hacker News
lupin search youtube "query" --date-from 2025-01-01
```

Platforms: `web`, `google`, `x`, `reddit`, `hn`, `youtube`, `instagram`, `tiktok`, `polymarket`

| Flag                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `--format <fmt>`            | `json` (default), `markdown`             |
| `--limit <n>`               | Max results (default: 10)                |
| `--sort <order>`            | `relevance` (default), `recent`          |
| `--date-from <date>`        | Start date filter (YYYY-MM-DD)           |
| `--date-to <date>`          | End date filter (YYYY-MM-DD)             |
| `--site <domain>`           | Restrict results to domain               |
| `--engine <engine>`         | Search engine override                   |
| `--proxy <url>`             | Single proxy                             |
| `--proxy-list <file\|list>` | Proxy list file or comma-separated       |
| `--proxy-rotate <strategy>` | `round-robin`, `random`, `sticky-domain` |

## download

Download video or audio from YouTube, TikTok, Instagram, or any [yt-dlp-supported site](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). Requires `lupin setup --with-video`.

```bash
lupin download https://www.youtube.com/watch?v=dQw4w9WgXcQ
lupin download <url> --audio-only                          # extract MP3
lupin download <url> --subtitles                           # also grab subs
lupin download <url> --output-dir ./downloads
```

| Flag                 | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `--output-dir <dir>` | Directory to save the file (default: current directory)  |
| `--audio-only`       | Extract audio only as MP3                                |
| `--subtitles`        | Download subtitles if available (all languages)          |
| `--timeout <ms>`     | Download timeout in milliseconds (default: `300000`)     |
| `--quiet`            | Suppress yt-dlp progress output on stderr                |

Returns JSON metadata:

```json
{
  "entityType": "download",
  "title": "Never Gonna Give You Up",
  "author": { "name": "Rick Astley", "url": "https://www.youtube.com/@RickAstleyYT" },
  "publishedAt": "2009-10-25",
  "platform": { "site": "youtube", "videoId": "dQw4w9WgXcQ" },
  "file": {
    "path": "/abs/path/Never Gonna Give You Up [dQw4w9WgXcQ].mp4",
    "sizeBytes": 12345678,
    "format": "mp4",
    "durationSeconds": 213
  },
  "subtitles": null,
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/..."
}
```

Notes:
- `--no-playlist` is enforced — pass a single video URL, not a playlist URL.
- `--extract` / `--schema` are not supported on `download` (video files are binary, not text).

## crawl

Walk a site from a start URL, extracting content from every reachable page within scope.

```bash
lupin crawl https://example.com --depth 2 --limit 50
lupin crawl https://docs.example.com --format markdown -o docs.jsonl
lupin crawl https://example.com --extract "summarize" --llm ollama
```

| Flag                    | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `--depth <N>`           | Max crawl depth (default: 3)                                  |
| `--limit <N>`           | Max pages to crawl (default: 100)                             |
| `--scope <strategy>`    | Scope strategy (default: `same-hostname`)                     |
| `--include <globs>`     | Comma-separated include globs                                 |
| `--exclude <globs>`     | Comma-separated exclude globs                                 |
| `--concurrency <N>`     | Parallel requests (default: 3)                                |
| `--delay <seconds>`     | Delay between requests                                        |
| `--engine <name>`       | Scraping engine (default: `auto`)                             |
| `--format <fmt>`        | `json` (default), `markdown`, `html`                          |
| `-o, --output <file>`   | Write output to file (JSONL for markdown/html, JSON for json) |
| `--from <file>`         | Read URLs from file (one per line) instead of crawling        |
| `--ignore-query-params` | Treat URLs with different query params as the same            |
| `--ignore-robots`       | Ignore `robots.txt` rules                                     |
| `--no-sitemap`          | Skip sitemap discovery                                        |
| `--extract <prompt>`    | Apply LLM extraction prompt to each page                      |
| `--schema <json\|file>` | JSON Schema for structured per-page LLM extraction            |

Also accepts `--llm`, `--llm-timeout`, and all proxy flags from `fetch`.

## map

Discover all URLs on a site without scraping page content. Fast HTTP-only link following — useful to preview crawl scope.

```bash
lupin map https://example.com --depth 3 --limit 500
```

Accepts the same scoping flags as `crawl` (`--depth`, `--limit`, `--scope`, `--include`, `--exclude`, `--delay`, `-o`, `--ignore-query-params`, `--ignore-robots`, `--no-sitemap`).

## llm

Manage LLM providers for extraction.

```bash
lupin llm list                    # show configured providers
lupin llm add <name> --base-url <url> --model <model> [--api-key <key>] [--default]
lupin llm remove <name>           # remove a provider
lupin llm default <name>          # change default provider
```

See the [LLM extraction guide](./llm-extraction.md) for full setup instructions.

## platform

Manage built-in and external platform providers.

```bash
lupin platform list
lupin platform list --json
lupin platform install ./my-platform
lupin platform install @your-scope/lupin-platform-example
lupin platform update my-platform
lupin platform update --all
lupin platform update --check
lupin platform list --updates
lupin platform doctor my-platform
lupin platform doctor --all --smoke
lupin platform disable instagram
lupin platform enable instagram
lupin platform remove my-platform
```

`platform list` reports each provider's source kind, status, and manifest version:

```text
instagram (builtin, enabled, vbuiltin)
my-platform (path, disabled, v0.1.0)
```

`platform list --json` includes structured `status`, `version`, and `source` fields for automation. Status values are `enabled`, `disabled`, and `broken`.

`platform update` revalidates path-backed platforms, reinstalls npm-backed platforms from their stored specifier with lifecycle scripts disabled, and rolls back npm-backed updates if the updated package fails validation. Built-in platforms report that they update with `lupin-cli`.

`platform list --updates` and `platform update --check [name]` check availability without installing anything. npm-backed platforms are compared against npm registry metadata, built-ins reuse the core `lupin-cli` update check, and path-backed platforms report no remote update source. Registry failures are returned as degraded update checks.

External packages with the same platform `name` as a built-in provider override the built-in. The social/media providers can be installed from package sources such as `./packages/platform-instagram` during development or `@lupin/platform-instagram` after publishing.

`platform doctor <name|--all>` inspects manifest load, enabled/broken state, exposed tools, and registry issues. Add `--smoke` to run manifest-declared smoke tests; smoke checks may touch real external sites and are reported with per-check evidence.

## update

Check whether the installed Lupin CLI is behind the latest published npm release.

```bash
lupin update check
lupin update check --json
```

Text output reports the installed version, latest available version when the npm registry check succeeds, and the concrete update command if a newer release is available.

```text
Lupin CLI: 0.2.0 installed, 0.3.0 latest available
Update available: npm install -g lupin-cli@latest
```

If the registry cannot be reached, the result is explicitly degraded instead of treated as success.

`lupin doctor` includes the same core update check by default. Use `lupin doctor --no-update-check` to skip npm registry access.

## Global flags

| Flag           | Description                 |
| -------------- | --------------------------- |
| `--mcp`        | Start as MCP server (stdio) |
| `--json`       | Alias for `--format json`   |
| `--version`    | Show version                |
| `--help`, `-h` | Show help                   |
