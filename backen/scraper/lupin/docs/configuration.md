# Configuration

## Routing behavior

| Engine       | Behavior                                                               |
| ------------ | ---------------------------------------------------------------------- |
| `auto`       | HTTP -> Camoufox -> Patchright, with domain memory skipping lower stages |
| `http`       | Plain HTTP only                                                        |
| `camoufox`   | Camoufox headless only                                                 |
| `fallback`   | Patchright or self-hosted CDP target                                   |
| `patchright` | Alias for `fallback`                                                   |
| `fast`       | Alias for `http`                                                       |

Domain memory is stored at `~/.lupin/domain-memory.json` with a default 24h TTL.

---

## Result schema

### Success

```json
{
  "ok": true,
  "text": "Page content...",
  "textLength": 1234,
  "title": "Page Title",
  "status": 200,
  "url": "https://example.com",
  "engine": "http",
  "confidence": "high",
  "blocked": false,
  "reason": null,
  "mitigation": null,
  "warnings": [],
  "hostname": "example.com",
  "routedBy": "auto",
  "attempts": [
    { "engine": "http", "attempt": 1, "ok": true, "confidence": "high" }
  ]
}
```

- `confidence` — `"high"`, `"medium"`, or `"low"`.
- `mitigation` — present when challenge markers are detected alongside strong content.
- `reason` — describes why the attempt failed (null on success).
- `attempts` — every stage attempt made, including failures.

### Error

```json
{
  "error": "Unable to extract usable content from https://example.com (blocked by cloudflare challenge on all attempts)",
  "failure": {
    "reason": "blocked by cloudflare challenge on all attempts",
    "blockedBy": {
      "provider": "cloudflare",
      "kind": "challenge",
      "confidence": "high",
      "signals": ["title:Just a moment"]
    },
    "failedBy": null
  },
  "attempts": [{ "engine": "http", "attempt": 1, "ok": false, "blocked": true }]
}
```

---

## Environment variables

### General

| Variable              | Default          | Description                                   |
| --------------------- | ---------------- | --------------------------------------------- |
| `LUPIN_STATE_DIR`     | `~/.lupin`       | Root directory for domain memory and profiles |
| `LUPIN_DOMAIN_TTL_MS` | `86400000` (24h) | How long domain memory entries persist        |

### HTTP stage

| Variable                | Default   | Description               |
| ----------------------- | --------- | ------------------------- |
| `LUPIN_HTTP_TIMEOUT_MS` | `15000`   | HTTP fetch timeout        |
| `LUPIN_HTTP_USER_AGENT` | Chrome UA | User-Agent header         |
| `LUPIN_CA_BUNDLE`       | —         | Custom CA PEM bundle path |
| `LUPIN_USE_SYSTEM_CA`   | `true`    | Use system CA bundle      |

### Camoufox stage

| Variable                     | Default                             | Description        |
| ---------------------------- | ----------------------------------- | ------------------ |
| `LUPIN_CAMOUFOX_HEADLESS`    | `true`                              | Run headless       |
| `LUPIN_CAMOUFOX_TIMEOUT_MS`  | `30000`                             | Navigation timeout |
| `LUPIN_CAMOUFOX_RETRIES`     | `1`                                 | Retry count        |
| `LUPIN_CAMOUFOX_PROFILE_DIR` | `~/.lupin/profiles/camoufox-middle` | Profile directory  |

### Fallback stage

| Variable                         | Default                                 | Description                   |
| -------------------------------- | --------------------------------------- | ----------------------------- |
| `LUPIN_FALLBACK_PROVIDER`        | `patchright`                            | `patchright` or `cdp`         |
| `LUPIN_FALLBACK_HEADLESS`        | `false`                                 | Run headless                  |
| `LUPIN_FALLBACK_TIMEOUT_MS`      | `35000`                                 | Navigation timeout            |
| `LUPIN_FALLBACK_RETRIES`         | `2`                                     | Retry count                   |
| `LUPIN_PROFILE_DIR`              | `~/.lupin/profiles/patchright-fallback` | Profile directory             |
| `LUPIN_CHROME_CHANNEL`           | `chrome`                                | Chrome channel for Patchright |
| `LUPIN_EXECUTABLE_PATH`          | —                                       | Custom Chrome executable      |
| `LUPIN_FALLBACK_LOCK_TIMEOUT_MS` | `120000`                                | Lock wait timeout             |
| `LUPIN_FALLBACK_LOCK_POLL_MS`    | `500`                                   | Lock polling interval         |
| `LUPIN_FALLBACK_LOCK_ORPHAN_MS`  | `30000`                                 | Stale lock threshold          |

### CDP

| Variable                       | Default | Description                                    |
| ------------------------------ | ------- | ---------------------------------------------- |
| `LUPIN_CDP_URL`                | —       | CDP endpoint (required when provider is `cdp`) |
| `LUPIN_CDP_CONNECT_TIMEOUT_MS` | `20000` | CDP connection timeout                         |

### Video download

| Variable                    | Default         | Description                         |
| --------------------------- | --------------- | ----------------------------------- |
| `LUPIN_DOWNLOAD_TIMEOUT_MS` | `300000` (5min) | Per-download timeout for `yt-dlp`   |

### Proxy

| Variable                       | Default       | Description                                                 |
| ------------------------------ | ------------- | ----------------------------------------------------------- |
| `LUPIN_PROXY_SERVER`           | —             | Single proxy server URL                                     |
| `LUPIN_PROXY_USERNAME`         | —             | Proxy username (for `LUPIN_PROXY_SERVER`)                   |
| `LUPIN_PROXY_PASSWORD`         | —             | Proxy password (for `LUPIN_PROXY_SERVER`)                   |
| `LUPIN_PROXY_LIST`             | —             | Comma-separated proxy URLs, single URL, or file path        |
| `LUPIN_PROXY_STRATEGY`         | `round-robin` | Rotation strategy: `round-robin`, `random`, `sticky-domain` |
| `LUPIN_PROXY_MAX_FAILS`        | `5`           | Mark proxy dead after N consecutive failures                |
| `LUPIN_PROXY_COOLDOWN_BASE_MS` | `30000`       | Base cooldown for failing proxies (exponential backoff)     |
| `LUPIN_PROXY_COOLDOWN_MAX_MS`  | `600000`      | Maximum cooldown cap                                        |

Accepted proxy formats: `user:pass@host:port`, `http://host:port`, `http://user:pass@host:port`, `socks5://host:port`, `host:port`.

Proxy applies to all engines (HTTP, Camoufox, Patchright) and all API-backed providers.
With `--proxy-list`, proxies rotate per-request (HTTP) or per-session (browser).
`sticky-domain` pins one proxy per domain — useful for crawling.
If all proxies are exhausted, requests fail rather than falling back to direct traffic.

### LLM

| Variable | Default | Description |
| --- | --- | --- |
| LLM providers are configured via `lupin llm add` and stored in `~/.lupin/llm.json` | | |

See the [LLM extraction guide](./llm-extraction.md) for setup instructions.
