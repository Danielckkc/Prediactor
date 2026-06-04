export function createSearchResponse(provider, query, usedStrategy, snapshotDate, results, warnings = [], blocked = false, startedAt = null) {
  return {
    provider,
    query,
    usedStrategy,
    snapshotDate,
    results,
    warnings,
    blocked,
    durationMs: startedAt ? Date.now() - startedAt : null,
  };
}

export function createFetchResponse(provider, url, finalUrl, snapshotDate, format, content, extra = {}) {
  const response = {
    provider,
    url,
    finalUrl,
    snapshotDate,
    format,
    content,
    warnings: extra.warnings || [],
    blocked: extra.blocked || false,
    extraction: extra.extraction || null,
    durationMs: extra.startedAt ? Date.now() - extra.startedAt : null,
  };

  // Carry screenshot buffer non-enumerably — invisible to JSON.stringify / MCP text,
  // but accessible for MCP image content blocks and CLI file output.
  if (extra.screenshotBuffer) {
    Object.defineProperty(response, "screenshotBuffer", {
      value: extra.screenshotBuffer,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(response, "screenshotMimeType", {
      value: extra.screenshotMimeType || "image/png",
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(response, "screenshotFormat", {
      value: extra.screenshotFormat || "png",
      enumerable: false,
      configurable: true,
    });
  }

  return response;
}
