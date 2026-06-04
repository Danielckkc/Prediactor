# Platform Updates Plan

## Purpose

Track the work needed to make Lupin platform providers easier to inspect, repair, and update over time, especially for fast-changing social media providers whose selectors and access patterns can break without warning.

This plan is intentionally explicit about current gaps. External social platform packages now own their provider implementation, so selector/site-specific fixes can ship as platform package patch releases. Built-in social providers still update with `lupin-cli`.

## Current State

- Built-in platforms are shipped with Lupin core under `src/platforms/builtin/*`.
- Built-in platform implementation code lives under `src/providers/*`.
- External social platform implementation code lives inside each `packages/platform-*` package under `providers/*`.
- External platforms can be installed from either a local path or an npm package with `lupin platform install <path|package>`.
- Platforms can currently be listed, installed, removed, enabled, and disabled.
- `lupin platform update` is available for revalidating path-backed platforms and updating npm-backed platforms.
- `lupin doctor`, `lupin update check`, and platform update checks provide explicit outdated/degraded signals.
- Local path platforms effectively update when files on disk change, but Lupin does not expose this as an update/revalidation workflow.
- npm-backed platforms are refreshed by `lupin platform update <name>` and roll back when validation fails.

## Definitions

### Built-in Platform

A provider bundled directly with `lupin-cli`. It updates only when the user updates Lupin itself.

Example:

```bash
npm install -g lupin-cli@latest
```

### npm-backed Platform

A provider installed from an npm package into Lupin's platform store.

Example:

```bash
lupin platform install @lupin/platform-instagram
```

This is the preferred future distribution model for volatile social providers because fixes can ship independently from core Lupin releases.

### Path-backed Platform

A provider registered from a local folder or manifest file.

Example:

```bash
lupin platform install ./my-lupin-platform
```

This is best for development, private providers, and fast local selector testing.

## Recommended Implementation Plan

### Phase 1: Platform Status and Metadata

Status: done

Add better metadata and status reporting to `lupin platform list`.

Required changes:

- Show platform `version` in text output.
- Add a normalized `status` field to platform descriptors:
  - `enabled`
  - `disabled`
  - `broken`
- Preserve existing fields such as `enabled`, `broken`, and `error` for compatibility.
- Include source details in JSON output:
  - builtin: manifest path
  - path: registered location
  - npm: package name, original specifier, installed root
- Keep load/validation issues visible in `platform list --json`.
- Update CLI docs and platform docs.
- Add tests for text and JSON output.

Example text output:

```text
instagram (builtin, enabled, vbuiltin)
local-demo (path, disabled, v0.0.1)
npm-demo (npm, enabled, v1.2.3)
```

Example JSON shape:

```json
{
  "name": "instagram",
  "displayName": "Instagram",
  "version": "builtin",
  "sourceKind": "builtin",
  "status": "enabled",
  "enabled": true,
  "broken": false,
  "source": {
    "kind": "builtin",
    "manifestPath": "/path/to/lupin.platform.json"
  }
}
```

### Phase 2: Core CLI Update Awareness

Status: done

Add an explicit way for users to know whether their installed Lupin CLI is outdated.

Recommended command surfaces:

```bash
lupin doctor
lupin update check
```

Required behavior:

- Report installed Lupin version.
- Check the latest published `lupin-cli` version from npm when network access is available.
- Clearly label network failures as degraded checks, not success.
- Include a concrete update command when an update is available.
- Do not perform network checks on every normal fetch/search command.

Example text output:

```text
Lupin CLI: 0.4.1 installed, 0.4.3 latest available
Update available: npm install -g lupin-cli@latest
```

Example JSON shape:

```json
{
  "lupin": {
    "version": "0.4.1",
    "latestVersion": "0.4.3",
    "updateAvailable": true,
    "updateCommand": "npm install -g lupin-cli@latest",
    "checkedAt": "2026-05-09T00:00:00.000Z"
  }
}
```

### Phase 3: `lupin platform update`

Status: done

Add first-class platform update commands.

Command surface:

```bash
lupin platform update <name>
lupin platform update --all
```

Required behavior by source kind:

- Built-in: report that the platform updates with `lupin-cli` and point to the core CLI update command.
- Path-backed: revalidate the current manifest and entry module; report current version and any errors.
- npm-backed: reinstall using the stored specifier, validate the manifest and tools, then activate the updated provider only if validation succeeds.

Integrity requirements:

- Do not leave users with a broken npm-backed provider after a failed update.
- If rollback is not possible for a specific failure mode, preserve the old registration and report the update as blocked.
- Keep npm lifecycle scripts disabled during install/update/uninstall.
- Return structured JSON with old version, new version, source kind, and update status.

Suggested statuses:

- `updated`
- `already-current`
- `revalidated`
- `skipped-builtin`
- `blocked`
- `failed-rolled-back`

### Phase 4: Update Availability for npm-backed Platforms

Status: done

Add opt-in update checks for platform packages.

Recommended command surfaces:

```bash
lupin platform list --updates
lupin platform update --check
```

Required behavior:

- For npm-backed platforms, compare installed manifest/package version to npm registry metadata.
- For path-backed platforms, do not claim update availability unless a future manifest field defines an update source.
- For built-in platforms, tie update availability to the core `lupin-cli` update check.
- Include snapshot/check date.
- Clearly report stale, missing, or unreachable registry data.

Example JSON fields:

```json
{
  "name": "instagram",
  "sourceKind": "npm",
  "version": "1.2.0",
  "latestVersion": "1.2.3",
  "updateAvailable": true,
  "updateCommand": "lupin platform update instagram",
  "checkedAt": "2026-05-09T00:00:00.000Z"
}
```

### Phase 5: Provider Failure Hints

Status: done

When a built-in or external platform fails in a way that may be caused by site changes, include a concise update hint.

Example:

```text
Instagram fetch failed. This may be caused by platform changes.
Run `lupin doctor` to check whether a newer Lupin release is available.
```

Requirements:

- Do not suggest updates for every generic user input error.
- Do not hide the real failure reason.
- Include hints in a structured field for JSON/MCP responses where feasible.

### Phase 6: Externalize Volatile Social Providers

Status: done

Move the most frequently changing social providers out of core once update mechanics are stable.

Candidate packages:

```text
@lupin/platform-instagram
@lupin/platform-tiktok
@lupin/platform-x
@lupin/platform-youtube
```

Recommended policy:

- Selector/site-specific fixes ship as platform package patch releases.
- Shared browser/session/proxy/cookie/runtime changes stay in `lupin-cli`.
- Built-in providers can remain as defaults during transition, but the preferred update path should become external packages.
- Avoid duplicate aliases between built-in and external providers unless there is a clear migration rule.

Migration options to decide later:

- Keep built-ins and let external packages override only when installed.
- Disable matching built-ins automatically when an external package with the same platform name is installed.
- Remove volatile built-ins in a major release after external packages are stable.

### Phase 7: Platform Doctor and Smoke Checks

Status: done

Add active verification for platform health.

Command surface:

```bash
lupin platform doctor <name>
lupin platform doctor --all
```

Potential manifest extension:

```json
{
  "doctor": {
    "handler": "doctor"
  }
}
```

Or:

```json
{
  "smokeTests": [
    {
      "kind": "fetch",
      "alias": "instagram",
      "url": "https://www.instagram.com/p/example/"
    }
  ]
}
```

Requirements:

- Prefer real public smoke paths where feasible.
- Fixture tests remain useful but must not be presented as production proof.
- Report blocked/degraded smoke checks explicitly.
- Include concise evidence: command run, target checked, result status, and snapshot date.

### Phase 8: Package-Owned Social Provider Implementations

Status: done

Move social provider implementation code into the external packages so selector/site-specific fixes can ship without a core `lupin-cli` release.

Implemented package-owned providers:

```text
packages/platform-instagram/providers/instagram/*
packages/platform-tiktok/providers/tiktok/*
packages/platform-x/providers/x/*
packages/platform-youtube/providers/youtube/*
```

Current boundary:

- Platform-specific selectors, parsing, smoke tests, and tool handlers live in the external packages.
- Shared runtime/base helpers still come from `lupin-cli`, such as browser management, markdown rendering, result shaping, platform search, and version/user-agent helpers.
- Built-in providers remain in core as defaults and fallback coverage during migration.
- Installed external packages with matching platform names override built-ins.

Verification completed on 2026-05-10:

- `npm pack --dry-run` for all four packages included package-owned provider files.
- Focused platform registry/CLI/example tests passed.
- External packages installed into a temporary `LUPIN_STATE_DIR` and passed live `lupin platform doctor --all --smoke --json` checks for Instagram, TikTok, X, and YouTube.
- Built-in social manifests also declare smoke tests and passed the default `lupin platform doctor --all --smoke --json` path.

## Suggested Implementation Order

1. Add platform status/version/source metadata.
2. Add core CLI update awareness in `doctor` or `update check`.
3. Add `lupin platform update <name|--all>`.
4. Add npm-backed update availability checks.
5. Add provider failure hints.
6. Externalize volatile social providers.
7. Add platform doctor/smoke checks.
8. Move social provider implementations into external packages.

## Verification Expectations

Each phase should include:

- Unit coverage for manager/registry behavior.
- CLI coverage for text and `--json` output.
- At least one realistic npm-backed fixture test using fake npm.
- For update checks, explicit tests for unavailable network or registry failures.
- For social provider externalization, at least one live smoke path per major provider when feasible.

## Open Questions

- Should built-in platform manifests use real semver matching the core package version instead of `"builtin"`?
- Should `lupin platform install <npm-package>` store the resolved installed package version separately from manifest version?
- Should update checks use npm directly, `npm view`, or registry HTTP requests?
- Should external packages be allowed to use the same platform `name` as built-ins for migration?
- Should automatic update hints be cached to avoid repeated network checks?
