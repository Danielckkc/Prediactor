import { cookieMatchesUrl } from "./cookies.js";
import { trimText } from "./extractors.js";

const BLOCKED_STATUS_CODES = new Set([401, 403, 429, 451, 503]);
const JS_SHELL_TEXT_THRESHOLD = 1200;
const JS_SHELL_HTML_THRESHOLD = 50000;
const GENERIC_BLOCK_TEXT_PATTERNS = [
  /access denied/i,
  /verify you are human/i,
  /please enable javascript/i,
  /enable javascript/i,
  /request blocked/i,
  /temporarily blocked/i,
  /press and hold/i,
  /^please wait\.{0,3}$/im,
  /^loading\.{0,3}$/im,
];
const FRAMEWORK_HYDRATION_MARKERS = [
  /__NEXT_DATA__/,
  /__NUXT__/,
  /window\.__INITIAL_STATE__/,
  /window\.__APP_DATA__/,
  /window\.__PRELOADED_STATE__/,
  /data-reactroot/,
  /data-react-helmet/,
];
const CLOUDFLARE_CHALLENGE_URL_PATTERNS = [
  /https?:\/\/challenges\.cloudflare\.com\//i,
  /\/cdn-cgi\/challenge-platform\//i,
];
const DATADOME_CHALLENGE_URL_PATTERNS = [
  /https?:\/\/(?:[\w-]+\.)?captcha-delivery\.com\//i,
];
const PERIMETERX_HTML_PATTERNS = [
  /window\._pxAppId\b/i,
  /window\._pxUuid\b/i,
  /px-captcha/i,
  /PerimeterX assignments/i,
  /captcha\.px-cloud\.net/i,
];

function summarizePattern(pattern) {
  return pattern.toString();
}

function lowerCaseHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

function titleMatches(title, patterns) {
  return patterns.some((pattern) => pattern.test(title || ""));
}

function findMatchingUrls(urls, patterns) {
  return urls.filter((candidate) => patterns.some((pattern) => pattern.test(candidate)));
}

function hasCookie(cookies, names, url) {
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  return cookies.some(
    (cookie) =>
      lowerNames.has(String(cookie.name || "").toLowerCase()) &&
      cookieMatchesUrl(cookie, url)
  );
}

export function normalizeHost(rawUrl) {
  const url = new URL(rawUrl);
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

function isGenericTitle(title, url) {
  const trimmedTitle = trimText(title).toLowerCase();
  if (!trimmedTitle) return true;

  const host = normalizeHost(url);
  const rootHost = host.split(".").slice(-2).join(".");
  const compactTitle = trimmedTitle.replace(/[^a-z0-9]+/g, "");
  const compactHost = host.replace(/[^a-z0-9]+/g, "");
  const compactRootHost = rootHost.replace(/[^a-z0-9]+/g, "");

  return compactTitle === compactHost || compactTitle === compactRootHost;
}

function detectCloudflareChallenge({ status, title, url, headers, frameUrls, scriptUrls, contentType }) {
  const signals = [];
  const challengeUrls = findMatchingUrls(
    [...frameUrls, ...scriptUrls],
    CLOUDFLARE_CHALLENGE_URL_PATTERNS
  );
  const serverHeader = headers.server?.toLowerCase() || "";
  const mitigated = headers["cf-mitigated"]?.toLowerCase() === "challenge";
  const challengeTitle = titleMatches(title, [/^just a moment/i, /^attention required/i]);
  const mainFrameIsChallenge = CLOUDFLARE_CHALLENGE_URL_PATTERNS.some((pattern) => pattern.test(url || ""));

  if (mitigated) signals.push("header cf-mitigated=challenge");
  if (mainFrameIsChallenge) signals.push(`main frame URL: ${url}`);
  if (challengeUrls.length > 0) signals.push(`challenge URL(s): ${challengeUrls.join(", ")}`);
  if (challengeTitle && serverHeader.includes("cloudflare")) signals.push(`challenge title: ${trimText(title)}`);

  const exact =
    mitigated ||
    mainFrameIsChallenge ||
    (challengeTitle &&
      serverHeader.includes("cloudflare") &&
      BLOCKED_STATUS_CODES.has(status) &&
      contentType.includes("text/html")) ||
    (challengeUrls.length > 0 &&
      serverHeader.includes("cloudflare") &&
      BLOCKED_STATUS_CODES.has(status) &&
      contentType.includes("text/html"));

  if (!exact) return null;

  return {
    provider: "cloudflare",
    kind: "challenge",
    confidence: mitigated || challengeUrls.length > 0 ? "high" : "medium",
    signals,
  };
}

function detectDataDomeChallenge({ status, url, headers, frameUrls, scriptUrls, cookies }) {
  const signals = [];
  const challengeUrls = findMatchingUrls(
    [...frameUrls, ...scriptUrls],
    DATADOME_CHALLENGE_URL_PATTERNS
  );
  const trafficRule = headers["x-datadome-traffic-rule-response"]?.toLowerCase() || "";
  const documentedProtected = headers["x-datadome"]?.toLowerCase() === "protected";
  const hasCidHeader = Boolean(headers["x-datadome-cid"]);
  const hasBlockHeader = Boolean(headers["x-dd-b"]);
  const hasDataDomeCookie = hasCookie(cookies, ["datadome", "ddsession", "ddoriginalreferrer"], url);
  const mainFrameIsChallenge = DATADOME_CHALLENGE_URL_PATTERNS.some((pattern) => pattern.test(url || ""));

  if (documentedProtected) signals.push("header x-datadome=protected");
  if (hasCidHeader) signals.push("header x-datadome-cid");
  if (hasBlockHeader) signals.push(`header x-dd-b=${headers["x-dd-b"]}`);
  if (trafficRule) signals.push(`header x-datadome-traffic-rule-response=${trafficRule}`);
  if (hasDataDomeCookie) signals.push("DataDome cookie present");
  if (mainFrameIsChallenge) signals.push(`main frame URL: ${url}`);
  if (challengeUrls.length > 0) signals.push(`challenge URL(s): ${challengeUrls.join(", ")}`);

  const exactTrafficRule = new Set(["block", "hard_block", "interstitial"]).has(trafficRule);
  const exact =
    mainFrameIsChallenge ||
    exactTrafficRule ||
    (BLOCKED_STATUS_CODES.has(status) &&
      (documentedProtected || challengeUrls.length > 0) &&
      (hasCidHeader || hasBlockHeader || hasDataDomeCookie || challengeUrls.length > 0));

  if (!exact) return null;

  return {
    provider: "datadome",
    kind: "challenge",
    confidence: challengeUrls.length > 0 || exactTrafficRule ? "high" : "medium",
    signals,
  };
}

function detectPerimeterXChallenge({ status, title, text, headers, rawHtml = "" }) {
  const signals = [];
  const pxBlocked = headers["x-px-blocked"]?.toLowerCase() === "1";
  const matchedHtmlPatterns = PERIMETERX_HTML_PATTERNS.filter((pattern) => pattern.test(rawHtml || ""));
  const challengeTitle = titleMatches(title, [/access to this page has been denied/i, /^before we continue/i]);
  const challengeText = /press\s*&?\s*hold/i.test(`${title || ""}\n${text || ""}`);

  if (pxBlocked) signals.push("header x-px-blocked=1");
  if (challengeTitle) signals.push(`challenge title: ${trimText(title)}`);
  if (challengeText) signals.push("challenge text: press & hold");
  if (matchedHtmlPatterns.length > 0) {
    signals.push(...matchedHtmlPatterns.map(summarizePattern));
  }

  const exact =
    (status === 403 || BLOCKED_STATUS_CODES.has(status)) &&
    (pxBlocked || matchedHtmlPatterns.length > 0 || (challengeTitle && challengeText));

  if (!exact) return null;

  return {
    provider: "perimeterx",
    kind: "challenge",
    confidence: pxBlocked || matchedHtmlPatterns.length > 0 ? "high" : "medium",
    signals,
  };
}

function detectGenericChallenge({ status, title, text }) {
  const trimmedText = trimText(text);
  const weakContent = trimmedText.length < JS_SHELL_TEXT_THRESHOLD;
  const blockedByStatus = BLOCKED_STATUS_CODES.has(status);
  const matchedPatterns = GENERIC_BLOCK_TEXT_PATTERNS.filter((pattern) =>
    pattern.test(`${title || ""}\n${trimmedText}`)
  );

  if (!blockedByStatus || !weakContent || matchedPatterns.length === 0) return null;

  return {
    provider: "generic",
    kind: "challenge",
    confidence: "low",
    signals: matchedPatterns.map(summarizePattern),
  };
}

function detectBrowserError({ url, title, text }) {
  const signals = [];
  const trimmedText = trimText(text);
  const browserErrorPatterns = [/ERR_[A-Z_]+/, /this site can[’']t be reached/i, /this page isn[’']t working/i];
  const matchedPatterns = browserErrorPatterns.filter((pattern) =>
    pattern.test(`${title || ""}\n${trimmedText}`)
  );

  if (String(url || "").startsWith("chrome-error://")) {
    signals.push(`main frame URL: ${url}`);
  }
  if (matchedPatterns.length > 0) {
    signals.push(...matchedPatterns.map(summarizePattern));
  }

  if (signals.length === 0) return null;

  return {
    provider: "browser",
    kind: "network_error",
    confidence: "high",
    signals,
  };
}

export function detectMitigation({ url, status, title, text, rawHtml, headers = {}, cookies = [], frameUrls = [], scriptUrls = [] }) {
  const normalizedHeaders = lowerCaseHeaders(headers);

  return (
    detectBrowserError({
      url,
      title,
      text,
    }) ||
    detectCloudflareChallenge({
      status,
      title,
      url,
      headers: normalizedHeaders,
      frameUrls,
      scriptUrls,
      contentType: normalizedHeaders["content-type"]?.toLowerCase() || "",
    }) ||
    detectDataDomeChallenge({
      status,
      url,
      headers: normalizedHeaders,
      frameUrls,
      scriptUrls,
      cookies,
    }) ||
    detectPerimeterXChallenge({
      status,
      title,
      text,
      headers: normalizedHeaders,
      rawHtml,
    }) ||
    detectGenericChallenge({
      status,
      title,
      text,
    })
  );
}

function detectJsShell(textLength, rawHtml) {
  if (!rawHtml) return null;
  const rawHtmlLength = rawHtml.length;
  const signals = [];

  // 1. Size-based: large HTML payload with very little visible text
  if (textLength < JS_SHELL_TEXT_THRESHOLD && rawHtmlLength > JS_SHELL_HTML_THRESHOLD) {
    signals.push(`${textLength} chars visible text in ${rawHtmlLength} byte HTML`);
  }

  // 2. Framework hydration markers with thin body text
  if (textLength < JS_SHELL_TEXT_THRESHOLD) {
    for (const marker of FRAMEWORK_HYDRATION_MARKERS) {
      if (marker.test(rawHtml)) {
        signals.push(`framework marker: ${marker.source}`);
        break;
      }
    }
  }

  // 3. JSON-LD structured data exists but body text is thin
  if (textLength < JS_SHELL_TEXT_THRESHOLD && rawHtml.includes('application/ld+json')) {
    signals.push("JSON-LD structured data present with thin body content");
  }

  return signals.length > 0 ? signals : null;
}

export function analyzeAttempt({ url, status, title, text, rawHtml, rawHtmlLength, headers = {}, cookies = [], frameUrls = [], scriptUrls = [], browserRendered = false }) {
  const trimmedText = trimText(text);
  const textLength = trimmedText.length;
  const genericTitle = isGenericTitle(title, url);
  const blockedByStatus = BLOCKED_STATUS_CODES.has(status);
  const strongContent = textLength >= JS_SHELL_TEXT_THRESHOLD && !genericTitle;
  const jsShellSignals = browserRendered ? null : detectJsShell(textLength, rawHtml);
  const jsShell = jsShellSignals !== null;
  const effectiveRawHtmlLength = rawHtmlLength ?? rawHtml?.length;
  const mitigation = detectMitigation({
    url,
    status,
    title,
    text: trimmedText,
    rawHtml,
    headers,
    cookies,
    frameUrls,
    scriptUrls,
  });
  const ok =
    textLength >= 80 &&
    !mitigation &&
    !jsShell &&
    !(blockedByStatus && !strongContent) &&
    !(genericTitle && textLength < 600);

  const warnings = [];
  if (blockedByStatus && strongContent) warnings.push(`status ${status} but content looked usable`);
  if (jsShell && ok) warnings.push(`possible JS shell: ${jsShellSignals.join("; ")}`);
  if (mitigation && strongContent) {
    warnings.push(
      `${mitigation.provider} challenge markers present alongside strong content: ${mitigation.signals.join(", ")}`
    );
  }

  return {
    ok,
    blocked: !ok,
    confidence: ok ? (warnings.length > 0 ? "medium" : "high") : "low",
    text: trimmedText,
    textLength,
    title: trimText(title),
    status,
    url,
    warnings,
    mitigation,
    reason: ok
      ? null
      : mitigation
        ? `${mitigation.provider} ${mitigation.kind}: ${mitigation.signals.join(", ")}`
      : jsShell
        ? `JS shell detected: ${jsShellSignals.join("; ")}`
      : blockedByStatus
        ? `status ${status}`
      : genericTitle && textLength < 600
        ? "generic page title with weak content"
        : "insufficient visible text",
  };
}
