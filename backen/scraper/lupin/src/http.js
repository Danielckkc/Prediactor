import fs from "node:fs";
import tls from "node:tls";

import * as cheerio from "cheerio";
import { Agent, ProxyAgent } from "undici";

import { BLOCK_TAGS, trimText } from "./extractors.js";

const DEFAULT_HTTP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const INSECURE_HTTP_DISPATCHER = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});
const DEFAULT_CA_BUNDLE_PATHS = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/usr/local/etc/openssl@3/cert.pem",
  "/opt/homebrew/etc/openssl@3/cert.pem",
];
const STRICT_HTTP_DISPATCHER_CACHE = new Map();

function absolutizeUrl(candidate, baseUrl) {
  if (!candidate) return null;

  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function pickLongestText(candidates) {
  for (const candidate of candidates) {
    const text = trimText(candidate.text());
    if (text.length >= 120) {
      return text;
    }
  }

  return "";
}

function parseSetCookieNames(response) {
  const rawCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];

  return rawCookies
    .map((cookie) => String(cookie).split(";")[0]?.split("=")[0]?.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function collectResourceUrls($, selector, attribute, baseUrl) {
  return $(selector)
    .map((_, node) => absolutizeUrl($(node).attr(attribute), baseUrl))
    .get()
    .filter(Boolean);
}

function readCaBundle(filePath) {
  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.includes("BEGIN CERTIFICATE") ? raw : null;
  } catch {
    return null;
  }
}

function buildTrustedCaEntries(options = {}) {
  const entries = [...tls.rootCertificates];

  if (options.caBundle) {
    entries.push(options.caBundle);
    return entries;
  }

  const explicitBundle = readCaBundle(options.caBundlePath || process.env.LUPIN_CA_BUNDLE);
  if (explicitBundle) {
    entries.push(explicitBundle);
    return entries;
  }

  if (options.useSystemCa === false) {
    return entries;
  }

  for (const candidate of DEFAULT_CA_BUNDLE_PATHS) {
    const bundle = readCaBundle(candidate);
    if (bundle) {
      entries.push(bundle);
      break;
    }
  }

  return entries;
}

function getStrictHttpDispatcher(options = {}) {
  if (options.caBundle) {
    return new Agent({
      connect: {
        ca: buildTrustedCaEntries(options),
      },
    });
  }

  const cacheKey = `${options.caBundlePath || process.env.LUPIN_CA_BUNDLE || ""}::${
    options.useSystemCa === false ? "bundled" : "system"
  }`;
  const cached = STRICT_HTTP_DISPATCHER_CACHE.get(cacheKey);
  if (cached) return cached;

  const dispatcher = new Agent({
    connect: {
      ca: buildTrustedCaEntries(options),
    },
  });
  STRICT_HTTP_DISPATCHER_CACHE.set(cacheKey, dispatcher);
  return dispatcher;
}

function getHttpDispatcher(options = {}) {
  const proxyUrl = options.proxyUrl;

  if (proxyUrl) {
    const connectOptions = options.ignoreHttpsErrors === true
      ? { rejectUnauthorized: false }
      : { ca: buildTrustedCaEntries(options) };

    return new ProxyAgent({
      uri: proxyUrl,
      requestTls: connectOptions,
    });
  }

  if (options.ignoreHttpsErrors === true) {
    return INSECURE_HTTP_DISPATCHER;
  }

  return getStrictHttpDispatcher(options);
}

export async function fetchHttpAttempt(url, options = {}) {
  const timeout = options.timeout ?? 15000;
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    dispatcher: getHttpDispatcher(options),
    signal: AbortSignal.timeout(timeout),
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": options.acceptLanguage || "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      DNT: "1",
      Pragma: "no-cache",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": options.userAgent || DEFAULT_HTTP_USER_AGENT,
      ...options.headers,
    },
  });

  const finalUrl = response.url || url;
  const headers = Object.fromEntries(response.headers.entries());
  const body = await response.text();
  const contentType = String(headers["content-type"] || "").toLowerCase();

  if (!contentType.includes("html")) {
    return {
      status: response.status,
      url: finalUrl,
      title: "",
      text: trimText(body),
      rawHtmlLength: body.length,
      headers,
      cookies: parseSetCookieNames(response),
      frameUrls: [],
      scriptUrls: [],
    };
  }

  const $ = cheerio.load(body);
  const frameUrls = collectResourceUrls($, "iframe[src]", "src", finalUrl);
  const scriptUrls = collectResourceUrls($, "script[src]", "src", finalUrl);
  $("script, style, noscript, template").remove();

  const title = trimText($("title").first().text());

  $(BLOCK_TAGS.join(",")).before("\n");
  $("br").replaceWith("\n");

  const mainText = pickLongestText([
    $("main").first(),
    $("article").first(),
    $('[role="main"]').first(),
  ]);
  const bodyText = trimText($("body").text());
  const text = mainText || bodyText;

  return {
    status: response.status,
    url: finalUrl,
    title,
    text,
    rawHtml: body,
    rawHtmlLength: body.length,
    headers,
    cookies: parseSetCookieNames(response),
    frameUrls,
    scriptUrls,
  };
}

/**
 * Create an undici dispatcher for a proxy URL.
 * Returns undefined if no proxy URL is provided (use default dispatcher).
 */
export function createProxyDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  return new ProxyAgent({ uri: proxyUrl });
}

export { DEFAULT_HTTP_USER_AGENT };
