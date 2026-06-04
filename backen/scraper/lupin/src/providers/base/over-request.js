/**
 * Over-request helper for platform-specific searches that apply a post-filter
 * to generic search engine results (e.g., keeping only /status/ URLs for X).
 *
 * The underlying engine returns a mix of matching and non-matching URLs, so we
 * request more than the user asked for to compensate for the expected loss.
 * If the first pass still falls short, one retry with a higher multiplier
 * bridges the gap without unbounded retries.
 */

/**
 * Compute the over-requested limit for the first engine call.
 *
 * @param {number} targetLimit - Number of filtered results the user asked for.
 * @param {number} multiplier - Expected inverse keep-rate (e.g., 2 for 50% keep rate).
 * @param {number} cap - Hard upper bound (matches MAX_WEB_SEARCH_LIMIT).
 */
export function overRequestLimit(targetLimit, multiplier, cap = 200) {
  const over = Math.ceil((targetLimit || 10) * multiplier);
  return Math.min(Math.max(over, targetLimit || 10), cap);
}

/**
 * Compute the retry limit when the first over-request was insufficient.
 * Doubles the multiplier for a second, more aggressive fetch.
 */
export function retryLimit(targetLimit, multiplier, cap = 200) {
  return overRequestLimit(targetLimit, multiplier * 2, cap);
}

/**
 * Merge two filtered result arrays, deduplicating by URL and re-indexing ranks.
 * Preserves the order of `primary`, then appends new URLs from `secondary`.
 */
export function mergeAndReindex(primary, secondary, limit) {
  const seen = new Set(primary.map((r) => r.url));
  const merged = [...primary];
  for (const result of secondary) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    merged.push(result);
    if (merged.length >= limit) break;
  }
  return merged.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}
