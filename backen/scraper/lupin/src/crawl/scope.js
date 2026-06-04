import picomatch from "picomatch";
import psl from "psl";

const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/;

/**
 * Extract the registrable domain using the Public Suffix List.
 * Falls back to the full hostname for IPs or unlisted TLDs.
 */
function registrableDomain(hostname) {
  const h = hostname.replace(/^www\./, "").toLowerCase();
  // IPs and IPv6 brackets: use exact hostname (no domain extraction)
  if (IP_PATTERN.test(h)) return h;
  const parsed = psl.parse(h);
  // psl.parse returns { listed: true, domain } for known public-suffix hostnames
  if (parsed && parsed.listed && parsed.domain) return parsed.domain;
  // Fallback: return the full hostname (localhost, unlisted TLDs, etc.)
  return h;
}

function stripWww(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createScopeChecker(startUrl, options = {}) {
  const scope = options.scope || "same-hostname";
  const startParsed = new URL(startUrl);
  const startHostStripped = stripWww(startParsed.hostname);
  const startDomain = registrableDomain(startParsed.hostname);
  // Normalize prefix origin for case-insensitive comparison
  const normalizedStartOrigin = new URL(startParsed.origin).origin;
  const startPrefix = normalizedStartOrigin + startParsed.pathname.replace(/\/?$/, "/");

  const includeMatchers = options.include?.length
    ? options.include.map((pattern) => picomatch(pattern))
    : null;
  const excludeMatchers = options.exclude?.length
    ? options.exclude.map((pattern) => picomatch(pattern))
    : null;

  return function isInScope(candidateUrl) {
    if (!isHttpUrl(candidateUrl)) return false;

    let parsed;
    try {
      parsed = new URL(candidateUrl);
    } catch {
      return false;
    }

    const candidateHost = stripWww(parsed.hostname);

    switch (scope) {
      case "same-hostname":
        if (candidateHost !== startHostStripped) return false;
        break;
      case "same-domain":
        if (registrableDomain(parsed.hostname) !== startDomain) return false;
        break;
      case "prefix": {
        const candidateNormalized = parsed.origin + parsed.pathname;
        if (!candidateNormalized.startsWith(startPrefix)) return false;
        break;
      }
      default:
        if (candidateHost !== startHostStripped) return false;
    }

    const pathname = parsed.pathname;
    if (excludeMatchers?.some((match) => match(pathname))) return false;
    if (includeMatchers && !includeMatchers.some((match) => match(pathname))) return false;

    return true;
  };
}
