# Build a Custom Platform

Lupin now separates platform registration from core scraping runtime.

Core stays responsible for:

- browser/session management
- HTTP fetching and proxy handling
- MCP transport
- shared fetch/search schemas
- shared result shapes
- LLM post-processing

Platform providers are loaded from manifests plus a small JavaScript entry module.

## Quick Start

The repo includes a minimal working example at [`examples/platforms/hello-platform`](../examples/platforms/hello-platform/).

Try it locally:

```bash
lupin platform install ./examples/platforms/hello-platform
lupin search hello-example "release notes"
lupin fetch hello-example https://example.com/posts/launch-day
```

When you're done:

```bash
lupin platform remove hello-example
```

## CLI

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

Built-in platforms can be disabled and re-enabled.
External platforms can be installed from a local path or an npm package name.
npm installs are run with lifecycle scripts disabled, so published platform packages must ship ready-to-run code.
When an installed external platform has the same platform `name` as a built-in provider, the external provider takes precedence and the matching built-in is skipped.

`lupin platform list` shows each platform's source kind, status, and manifest version:

```text
instagram (builtin, enabled, vbuiltin)
hello-example (path, enabled, v0.0.1)
```

`lupin platform list --json` includes structured metadata for automation:

```json
{
  "name": "hello-example",
  "displayName": "Hello Example",
  "version": "0.0.1",
  "sourceKind": "path",
  "status": "enabled",
  "enabled": true,
  "broken": false,
  "source": {
    "kind": "path",
    "manifestPath": "/path/to/hello-platform/lupin.platform.json",
    "location": "/path/to/hello-platform"
  }
}
```

Supported status values are:

- `enabled`: the platform loaded and its tools are active.
- `disabled`: the platform is registered but intentionally inactive.
- `broken`: the platform manifest loaded, but handlers or tools failed validation.

## Updating Platforms

```bash
lupin platform update <name>
lupin platform update --all
```

Update behavior depends on the platform source:

- Built-in platforms are skipped with a message to update `lupin-cli`.
- Path-backed platforms are revalidated from their current files on disk.
- npm-backed platforms are reinstalled from their stored npm specifier, validated, and rolled back if the updated package fails to load.

Text output reports the update status and version transition:

```text
my-platform: updated (1.0.0 -> 1.1.0)
instagram: skipped-builtin (builtin -> builtin): Built-in platform "instagram" updates with lupin-cli. Run: npm install -g lupin-cli@latest
```

`--json` returns structured statuses such as `updated`, `already-current`, `revalidated`, `skipped-builtin`, `blocked`, or `failed-rolled-back`.

## Checking Update Availability

```bash
lupin platform list --updates
lupin platform update --check
lupin platform update --check <name>
```

These commands check update availability without installing anything.

- npm-backed platforms are compared against npm registry metadata.
- Built-in platforms reuse the core `lupin-cli` update check.
- Path-backed platforms report no remote update source.

When update checks are requested, JSON output includes fields such as:

```json
{
  "name": "my-platform",
  "version": "1.0.0",
  "latestVersion": "1.1.0",
  "updateAvailable": true,
  "updateCommand": "lupin platform update my-platform",
  "updateCheckedAt": "2026-05-09T00:00:00.000Z",
  "updateCheck": {
    "ok": true,
    "degraded": false,
    "error": null
  }
}
```

If registry access fails, the result is marked as degraded and should not be treated as proof that a platform is current.

## Provider Failure Hints

When a platform provider fails in a way that may be caused by site changes, Lupin keeps the original error and may add a structured `updateHint` field.

Example CLI/MCP error payload:

```json
{
  "error": "selector no longer matches",
  "failure": null,
  "attempts": [],
  "updateHint": {
    "kind": "provider-update",
    "platform": "instagram",
    "sourceKind": "builtin",
    "message": "Instagram is built into lupin-cli and may need a Lupin update if the site changed.",
    "action": "Run `lupin doctor` or `lupin update check` to see whether a newer Lupin release includes provider fixes.",
    "commands": ["lupin doctor", "lupin update check"]
  }
}
```

Hints are intentionally not added for likely user input errors such as unsupported URLs or unknown platforms.

## Platform Doctor and Smoke Checks

```bash
lupin platform doctor <name>
lupin platform doctor --all
lupin platform doctor <name> --smoke
lupin platform doctor <name> --smoke --json
```

`platform doctor` checks whether a platform manifest loads, whether the platform is enabled, whether tools are exposed, and whether registry issues are attached to the platform.

`--smoke` also runs smoke tests declared by the platform manifest. Smoke tests are intentionally opt-in because real platform checks may hit public websites and can be blocked, rate-limited, or stale.

Manifest example:

```json
{
  "smokeTests": [
    {
      "name": "known-public-post",
      "kind": "fetch",
      "alias": "instagram",
      "url": "https://www.instagram.com/p/example/"
    },
    {
      "name": "search-index",
      "kind": "search",
      "alias": "youtube",
      "query": "OpenAI"
    }
  ]
}
```

Doctor JSON includes concise evidence for each check:

```json
{
  "name": "my-platform",
  "status": "ok",
  "checks": [
    {
      "name": "manifest",
      "status": "ok",
      "message": "Loaded manifest from /path/to/lupin.platform.json."
    },
    {
      "name": "smoke:known-public-post",
      "status": "ok",
      "message": "Fetch returned non-empty content.",
      "target": "https://www.instagram.com/p/example/",
      "snapshotDate": "2026-05-09T00:00:00.000Z"
    }
  ]
}
```

Fixture and manifest-load checks are useful for regression coverage, but successful live smoke checks are the stronger signal that a provider still works against the current external site.

## External Social Platform Packages

The volatile social/media providers are available as installable package sources in this repository:

```text
packages/platform-instagram
packages/platform-tiktok
packages/platform-x
packages/platform-youtube
```

They are intended to be published as:

```text
@lupin/platform-instagram
@lupin/platform-tiktok
@lupin/platform-x
@lupin/platform-youtube
```

Local development install:

```bash
lupin platform install ./packages/platform-instagram
lupin platform list
```

Future npm install:

```bash
lupin platform install @lupin/platform-instagram
lupin platform update instagram
```

These packages use the same platform names and tool aliases as their built-in counterparts. Once installed, they override the built-ins so provider fixes can ship as package updates instead of requiring a full `lupin-cli` release.

## Manifest

Every platform package must expose `lupin.platform.json` at its root.

```json
{
  "apiVersion": 1,
  "name": "my-platform",
  "displayName": "My Platform",
  "description": "Custom provider for a site or app",
  "version": "0.1.0",
  "entry": "./index.js",
  "tools": {
    "search": [
      {
        "tool": "search_myplatform",
        "alias": "myplatform",
        "description": "Search My Platform posts.",
        "inputSchema": "search.standard",
        "handler": "search"
      }
    ],
    "fetch": [
      {
        "tool": "fetch_myplatform_post",
        "alias": "myplatform",
        "description": "Fetch a My Platform post.",
        "inputSchema": "fetch.standard",
        "handler": "fetchPost"
      }
    ]
  }
}
```

## Entry Module

The `entry` file exports the handlers named in the manifest.

```js
export async function search(args, context) {
  const {
    createSearchResponse,
    snapshotDateUtc,
  } = context.sdk;

  return createSearchResponse(
    "my-platform",
    args.query,
    "custom",
    snapshotDateUtc(),
    [
      {
        rank: 1,
        title: "Example result",
        url: "https://example.com/post/1",
        snippet: "Result text",
      },
    ],
    []
  );
}

export async function fetchPost(args, context) {
  const {
    createFetchResponse,
    snapshotDateUtc,
  } = context.sdk;

  return createFetchResponse(
    "my-platform",
    args.url,
    args.url,
    snapshotDateUtc(),
    args.format || "json",
    {
      entityType: "post",
      title: "Example post",
      author: { name: "Example", handle: null, url: null },
      publishedAt: null,
      text: "Hello from a custom platform.",
      stats: {},
      media: [],
      outboundLinks: [],
      comments: [],
      platform: {
        site: "my-platform",
        canonicalUrl: args.url,
      },
    },
    {
      extraction: {
        method: "custom",
        confidence: "high",
      },
    }
  );
}
```

`context.sdk` is always available at runtime and is the most portable way to access Lupin's helper utilities from a platform package.
If your platform package also resolves `lupin-cli` normally, you can optionally import the same helpers from `lupin-cli/platform-sdk`.
Entry modules should use ESM named exports, and the manifest `entry` path must stay inside the platform package directory.

## Handler Contract

Handlers receive:

- `args`: the MCP/CLI tool arguments for that operation
- `context.scraper`: the Lupin scraper instance
- `context.browserManager`: the shared browser manager
- `context.fetcher`: proxy-aware fetch function when available
- `context.sdk`: shared response helpers and schema constants from Lupin's platform SDK
- `context.stateDir`: Lupin state directory

Search handlers should return the standard search response shape.
Fetch handlers should return the standard fetch response shape, including `content.media` when media is available so core LLM multimodal extraction can reuse it.

## Publishing Checklist

- Include `lupin.platform.json` at the package root
- Export handlers from an ESM entry file such as `index.js`
- Ship built files directly in the package you publish
- Do not rely on `postinstall` or other npm lifecycle scripts
- Test the package locally with `lupin platform install ./path-to-package`

## Schema References

Supported manifest schema references:

- `search.standard`
- `fetch.standard`
- `fetch.page`

You can also inline a JSON Schema object instead of using a string reference.

## Browser Requirements

If a tool requires browser assets even before execution, declare it in the manifest:

```json
{
  "tool": "fetch_myplatform_profile",
  "alias": "myplatform-profile",
  "description": "Fetch a profile page.",
  "inputSchema": "fetch.standard",
  "handler": "fetchProfile",
  "browser": {
    "camoufox": true
  }
}
```

This controls CLI/MCP preflight checks and tool exposure behavior.
