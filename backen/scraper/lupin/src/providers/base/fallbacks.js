export function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function snapshotDateUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function mergeSearchQuery(query, options = {}) {
  const parts = [query];

  if (options.site) {
    parts.push(`site:${options.site}`);
  }

  for (const domain of options.includeDomains || []) {
    parts.push(`site:${domain}`);
  }

  for (const domain of options.excludeDomains || []) {
    parts.push(`-site:${domain}`);
  }

  return parts.filter(Boolean).join(" ").trim();
}
