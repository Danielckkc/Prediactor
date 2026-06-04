function getUrlHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isCookieScopedUrl(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function cookieMatchesUrl(cookie = {}, rawUrl) {
  const cookieDomain = String(cookie.domain || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();
  if (!cookieDomain) return true;

  const host = getUrlHostname(rawUrl);
  if (!host) return false;

  return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}

export async function getScopedCookies(cookieSource, rawUrl) {
  if (!cookieSource || typeof cookieSource.cookies !== "function" || !isCookieScopedUrl(rawUrl)) {
    return [];
  }

  return cookieSource.cookies([rawUrl]).catch(() => []);
}
