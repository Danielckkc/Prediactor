import { BrowserManager } from "../../runtime/browser-manager.js";
import { request } from "undici";
import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { decodeHtmlEntities } from "../base/html.js";
import { buildProfileMarkdownContent } from "../base/profile.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { userAgent } from "../../version.js";

const DEFAULT_HEADERS = {
  "User-Agent": userAgent,
};
const INSTAGRAM_APP_ID = "936619743392459";

function getMetaContent(html, key, attr = "property") {
  const pattern = new RegExp(`<meta[^>]+${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]+content="([^"]*)"`, "i");
  return decodeHtmlEntities(html.match(pattern)?.[1] || "");
}

function getLinkHref(html, rel) {
  const pattern = new RegExp(`<link[^>]+rel="${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]+href="([^"]*)"`, "i");
  return decodeHtmlEntities(html.match(pattern)?.[1] || "");
}

function parseDescription(description) {
  const text = String(description || "").trim();
  const match =
    text.match(/^([\d,.\sKMB]+)\s+likes?,\s+([\d,.\sKMB]+)\s+comments?\s+-\s+([a-z0-9._]+)\s+on\s+([^:]+):\s+"([\s\S]*)"\.\s*$/i) ||
    text.match(/^([\d,.\sKMB]+)\s+likes?,\s+([\d,.\sKMB]+)\s+comments?\s+-\s+([a-z0-9._]+):\s+"([\s\S]*)"\.\s*$/i);

  if (!match) {
    return {
      likes: null,
      comments: null,
      username: null,
      publishedAt: null,
      caption: text || "",
    };
  }

  if (match.length === 6) {
    return {
      likes: match[1].trim(),
      comments: match[2].trim(),
      username: match[3].trim(),
      publishedAt: match[4].trim(),
      caption: match[5].trim(),
    };
  }

  return {
    likes: match[1].trim(),
    comments: match[2].trim(),
    username: match[3].trim(),
    publishedAt: null,
    caption: match[4].trim(),
  };
}

function inferEntityType(url) {
  if (/\/reels?\//i.test(url)) return "reel";
  if (isProfileUrl(url)) return "profile";
  return "post";
}

function isProfileUrl(url) {
  try {
    const { pathname } = new URL(url);
    // Profile URLs: /<username>/ — no /p/, /reel/, /reels/, /stories/, /explore/, etc.
    const cleaned = pathname.replace(/\/+$/, "");
    if (!cleaned || cleaned === "") return true; // bare domain
    const segments = cleaned.split("/").filter(Boolean);
    if (segments.length !== 1) return false;
    // Exclude known non-profile single-segment paths
    const reserved = new Set([
      "p", "reel", "reels", "stories", "explore", "accounts", "directory",
      "about", "legal", "developer", "tv", "audio", "challenge", "hashtag",
      "location", "ar", "download", "privacy", "safety",
    ]);
    return !reserved.has(segments[0].toLowerCase());
  } catch {
    return false;
  }
}

function buildSyntheticTitle(entityType, author) {
  const handle = author?.handle || null;
  const name = author?.name || null;
  if (handle) {
    return `Instagram ${entityType} by ${handle}`;
  }
  if (name) {
    return `${name} on Instagram`;
  }
  return `Instagram ${entityType}`;
}

function buildMarkdownContent(content, finalUrl) {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.author?.handle) lines.push(content.author.handle);
  if (content.publishedAt) lines.push(content.publishedAt);
  if (content.text) lines.push(content.text);
  if (content.stats) {
    const statLines = Object.entries(content.stats)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${value}`);
    if (statLines.length) lines.push(statLines.join("\n"));
  }
  if (content.comments?.length) {
    lines.push(
      `Comments:\n${content.comments
        .map((comment, index) => `${index + 1}. ${comment.author?.handle || comment.author?.name || "Unknown"}: ${comment.text}`)
        .join("\n")}`
    );
  }

  return renderPageMarkdown({
    title: content.title || "Instagram Post",
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}

function parseProfileDescription(description) {
  // "673M Followers, 643 Following, 4,033 Posts - See Instagram photos and videos from Cristiano Ronaldo (@cristiano)"
  const text = String(description || "").trim();
  const match = text.match(
    /^([\d,.]+[KMB]?)\s+Followers?,\s*([\d,.]+[KMB]?)\s+Following,\s*([\d,.]+[KMB]?)\s+Posts?\s*[-–—]\s*See\s+Instagram\s+photos\s+and\s+videos\s+from\s+(.+?)\s+\(@([^)]+)\)\s*$/i
  );
  if (!match) {
    const fallback = text.match(
      /^([\d,.]+[KMB]?)\s+Followers?,\s*([\d,.]+[KMB]?)\s+Following,\s*([\d,.]+[KMB]?)\s+Posts?/i
    );
    return {
      followers: fallback?.[1]?.trim() || null,
      following: fallback?.[2]?.trim() || null,
      posts: fallback?.[3]?.trim() || null,
      fullName: null,
      username: null,
    };
  }
  return {
    followers: match[1].trim(),
    following: match[2].trim(),
    posts: match[3].trim(),
    fullName: match[4].trim(),
    username: match[5].trim(),
  };
}

function parseHeaderText(headerText) {
  // headerText format from Camoufox:
  // "username\nVerified (optional)\nOptions (optional)\nFull Name\nN posts\nNM followers\nN following\nBio text..."
  // or: "username\nFull Name\nN posts\nNM followers\nN following\nBio text..."
  const lines = headerText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return null;

  const result = { username: null, fullName: null, posts: null, followers: null, following: null, bio: null, isVerified: false };

  // First line is always the username
  result.username = lines[0];

  // Find stats lines — they contain "posts", "followers", "following"
  let statsStart = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*[\d,.]+[KMB]?\s+posts?\s*$/i.test(lines[i])) {
      statsStart = i;
      break;
    }
  }

  if (statsStart === -1) return null;

  // Check for "Verified" between username and fullName
  result.isVerified = lines.slice(1, statsStart).some((l) => /^verified$/i.test(l));

  // Full name is the line just before stats, excluding "Verified"/"Options" markers
  const nameCandidates = lines.slice(1, statsStart).filter(
    (l) => !/^(verified|options|suggested)$/i.test(l)
  );
  result.fullName = nameCandidates[nameCandidates.length - 1] || null;

  // Parse stats: "4,033 posts", "672M followers", "630 following"
  // Scan forward from statsStart, consuming only stat lines
  const statPattern = /^[\d,.]+[KMB]?\s+(posts?|followers?|following)$/i;
  let bioStart = statsStart;
  for (let i = statsStart; i < lines.length; i++) {
    if (!statPattern.test(lines[i])) break;
    bioStart = i + 1;
    const postsMatch = lines[i].match(/^([\d,.]+[KMB]?)\s+posts?$/i);
    const followersMatch = lines[i].match(/^([\d,.]+[KMB]?)\s+followers?$/i);
    const followingMatch = lines[i].match(/^([\d,.]+[KMB]?)\s+following$/i);
    if (postsMatch) result.posts = postsMatch[1];
    if (followersMatch) result.followers = followersMatch[1];
    if (followingMatch) result.following = followingMatch[1];
  }

  // Bio is everything after the stats block, up to known non-bio markers
  // Instagram renders buttons ("Follow", "Message") and highlight labels after the bio
  const nonBioPattern = /^(follow|message|following|options|suggested|more|posts|reels|tagged|gift guide|log in|sign up)$/i;
  if (bioStart < lines.length) {
    const bioLines = [];
    for (let i = bioStart; i < lines.length; i++) {
      if (nonBioPattern.test(lines[i].trim())) break;
      bioLines.push(lines[i]);
    }
    result.bio = bioLines.join("\n") || null;
  }

  return result;
}

function extractInstagramUsername(url) {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split("/").filter(Boolean);
    return segments[0] || null;
  } catch {
    return null;
  }
}

function buildInstagramApiHeaders(username) {
  return {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": DEFAULT_HEADERS["User-Agent"],
    referer: `https://www.instagram.com/${username}/`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-ig-app-id": INSTAGRAM_APP_ID,
    "x-requested-with": "XMLHttpRequest",
  };
}

async function fetchInstagramProfileApi(username) {
  if (!username) return null;
  const { statusCode, body } = await request(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    {
      method: "GET",
      headers: buildInstagramApiHeaders(username),
    }
  );

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Instagram profile API failed with status ${statusCode}`);
  }

  const payload = await body.json();
  return payload?.data?.user || null;
}

function mapInstagramShortcodeUrl(shortcode, typename) {
  if (!shortcode) return null;
  if (typename === "GraphVideo") {
    return `https://www.instagram.com/reel/${shortcode}/`;
  }
  return `https://www.instagram.com/p/${shortcode}/`;
}

function mapInstagramLatestPosts(user) {
  const seen = new Set();
  const latestPosts = [];
  const collections = [
    ...(user?.edge_owner_to_timeline_media?.edges || []),
    ...(user?.edge_felix_video_timeline?.edges || []),
  ];

  for (const edge of collections) {
    const node = edge?.node;
    const url = mapInstagramShortcodeUrl(node?.shortcode, node?.__typename);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    latestPosts.push({
      url,
      type: node?.__typename === "GraphVideo" ? "reel" : "post",
    });
    if (latestPosts.length >= 12) break;
  }

  return latestPosts;
}

async function extractProfileFromBrowser(url, options, manager) {
  const pageTimeout = options.timeout || 30000;
  const session = await manager.openSession({
    engine: "camoufox",
    timeout: pageTimeout,
  });

  try {
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: pageTimeout,
    });

    // Wait for profile content to render (profile pic + post grid)
    await Promise.race([
      session.page.waitForFunction(
        () => !!document.querySelector('img[alt*="profile picture"]')
      ),
      session.page.waitForTimeout(8000),
    ]).catch(() => {});

    // Dismiss overlays (login wall, cookie consent) — no sleep needed, just fire and check
    await session.page.evaluate(() => {
      for (const btn of document.querySelectorAll("button")) {
        const t = btn.textContent.trim().toLowerCase();
        if (t.includes("not now") || t.includes("decline") || t.includes("accept")) btn.click();
      }
    });

    const result = await session.page.evaluate(() => {
      // Extract header section text — first <section> inside <header> has the profile info
      const header = document.querySelector("header");
      // Get only the profile info section, not highlights/story buttons
      // The header structure is: [avatar div] [section with stats+bio]
      const section = header?.querySelector("section");
      const headerText = section?.innerText || header?.innerText || "";

      // Verified badge: SVG with aria-label="Verified" or title="Verified"
      const isVerified = !!document.querySelector('svg[aria-label="Verified"]') ||
        !!document.querySelector('[title="Verified"]');

      // Profile picture: img with alt containing "profile picture" — prefer largest
      const profilePics = [...document.querySelectorAll("img")]
        .filter((img) => img.alt && /profile picture/i.test(img.alt))
        .map((img) => img.src);

      // Latest post/reel links
      const postLinks = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
        .map((a) => a.href);

      // External link if present
      const externalLink = document.querySelector('a[rel="me nofollow noopener noreferrer"]');

      return {
        headerText,
        isVerified,
        profilePic: profilePics[profilePics.length - 1] || profilePics[0] || null,
        postLinks: [...new Set(postLinks)],
        externalUrl: externalLink?.href || null,
      };
    });
    return result;
  } finally {
    await session.close().catch(() => {});
  }
}

export async function fetchInstagramProfile(_scraper, url, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const format = options.format || "json";
  const requestedUsername = extractInstagramUsername(url);

  // Run HTTP and browser extraction in parallel — they're independent
  const httpPromise = fetch(url, { headers: DEFAULT_HEADERS }).then(async (response) => {
    if (!response.ok) throw new Error(`Instagram fetch failed with status ${response.status}`);
    const html = await response.text();
    const canonicalUrl = getLinkHref(html, "canonical") || url;
    const title = getMetaContent(html, "og:title");
    const description = getMetaContent(html, "og:description");
    const ogImage = getMetaContent(html, "og:image");
    const metaParsed = parseProfileDescription(description);
    const handleFromTitle = title.match(/\(@([^)]+)\)/)?.[1] || null;
    return { canonicalUrl, title, ogImage, metaParsed, handleFromTitle, html };
  });
  const apiPromise = fetchInstagramProfileApi(requestedUsername).catch(() => null);

  const browserPromise = extractProfileFromBrowser(url, options, manager).catch(() => null);

  const [httpData, apiUser, browserData] = await Promise.all([httpPromise, apiPromise, browserPromise]);
  const { canonicalUrl, title, ogImage, metaParsed } = httpData;
  const metaUsername = metaParsed.username || httpData.handleFromTitle || apiUser?.username;
  const headerParsed = browserData ? parseHeaderText(browserData.headerText) : null;

  // Merge: browser data takes priority where available
  const username = apiUser?.username || headerParsed?.username || metaUsername;
  const handle = username ? `@${username}` : null;
  const fullName = apiUser?.full_name || headerParsed?.fullName || metaParsed.fullName || title.match(/^(.+?)\s*\(/)?.[1]?.trim() || null;
  const profileUrl = username ? `https://www.instagram.com/${username}/` : canonicalUrl;
  const bio = apiUser?.biography || headerParsed?.bio || "";
  const isVerified = apiUser?.is_verified || browserData?.isVerified || headerParsed?.isVerified || httpData.html.includes('"is_verified":true');
  const profilePic = apiUser?.profile_pic_url_hd || apiUser?.profile_pic_url || browserData?.profilePic || ogImage || null;
  const latestPosts = mapInstagramLatestPosts(apiUser).length > 0 ? mapInstagramLatestPosts(apiUser) : (browserData?.postLinks || []).slice(0, 12).map((postUrl) => ({
    url: postUrl,
    type: /\/reel\//.test(postUrl) ? "reel" : "post",
  }));
  const outboundLinks = [];
  for (const link of apiUser?.bio_links || []) {
    if (link?.url) outboundLinks.push(link.url);
  }
  if (apiUser?.external_url && !outboundLinks.includes(apiUser.external_url)) {
    outboundLinks.push(apiUser.external_url);
  }
  if (browserData?.externalUrl && !outboundLinks.includes(browserData.externalUrl)) {
    outboundLinks.push(browserData.externalUrl);
  }

  const author = {
    name: fullName,
    handle,
    url: profileUrl,
  };

  const content = {
    entityType: "profile",
    title: fullName ? `${fullName} (${handle})` : handle || "Instagram Profile",
    author,
    publishedAt: null,
    text: bio,
    stats: {
      followerCount: apiUser?.edge_followed_by?.count ?? headerParsed?.followers ?? metaParsed.followers,
      followingCount: apiUser?.edge_follow?.count ?? headerParsed?.following ?? metaParsed.following,
      postCount: apiUser?.edge_owner_to_timeline_media?.count ?? headerParsed?.posts ?? metaParsed.posts,
    },
    media: profilePic ? [{ type: "image", url: profilePic }] : [],
    latestPosts,
    outboundLinks,
    comments: [],
    platform: {
      site: "instagram",
      canonicalUrl: profileUrl,
      pathType: "profile",
      username: username || null,
      isVerified,
    },
  };

  const hasApiData = !!apiUser;
  const hasBrowserData = !!headerParsed;
  return createFetchResponse(
    "instagram",
    url,
    profileUrl,
    snapshotDateUtc(),
    format,
    format === "markdown" ? buildProfileMarkdownContent(content, profileUrl, "Instagram") : content,
    {
      startedAt,
      warnings: [],
      blocked: false,
      extraction: {
        method: hasApiData ? "instagram_profile_api" : hasBrowserData ? "instagram_profile_browser" : "instagram_public_meta",
        confidence: hasApiData || hasBrowserData ? "high" : metaParsed.followers ? "medium" : "low",
      },
    }
  );
}

async function extractPostCommentsFromBrowser(url, options, manager, maxComments) {
  const pageTimeout = options.timeout || 30000;
  const session = await manager.openSession({ engine: "camoufox", timeout: pageTimeout });
  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    // Let the post + comment list render
    await Promise.race([
      session.page.waitForFunction(() => !!document.querySelector("article")),
      session.page.waitForTimeout(8000),
    ]).catch(() => {});
    // Dismiss login wall / cookie overlays that hide comments
    await session.page.evaluate(() => {
      for (const btn of document.querySelectorAll("button")) {
        const t = btn.textContent.trim().toLowerCase();
        if (t.includes("not now") || t.includes("decline") || t.includes("allow all cookies") || t.includes("accept")) btn.click();
      }
    });
    await session.page.waitForTimeout(1500).catch(() => {});
    // Best-effort DOM scrape: IG renders comments as <ul><li>, each with a
    // profile link (username) + a text span. Fragile by nature — selectors
    // change, and a login wall may hide comments without auth cookies.
    const raw = await session.page.evaluate((max) => {
      const out = [];
      const article = document.querySelector("article") || document.body;
      for (const li of article.querySelectorAll("ul li")) {
        const link = li.querySelector('a[href^="/"]');
        const username = link ? link.getAttribute("href").replace(/\//g, "").trim() : null;
        const textEl = [...li.querySelectorAll('span[dir="auto"], h1, h2')]
          .find((el) => el.textContent.trim().length > 0);
        const text = textEl ? textEl.textContent.trim() : "";
        if (username && text && text !== username) out.push({ username, text });
        if (out.length >= max + 1) break;
      }
      return out;
    }, maxComments);
    return raw;
  } finally {
    await session.close().catch(() => {});
  }
}

export async function fetchInstagramPost(scraper, url, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const fetcher = scraper?.fetch ? scraper.fetch.bind(scraper) : fetch;
  const response = await fetcher(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`Instagram fetch failed with status ${response.status}`);
  }

  const html = await response.text();
  const canonicalUrl = getLinkHref(html, "canonical") || url;
  const title = getMetaContent(html, "og:title");
  const description = getMetaContent(html, "og:description");
  const image = getMetaContent(html, "og:image");
  const twitterTitle = getMetaContent(html, "twitter:title", "name");
  const parsed = parseDescription(description);
  const usernameFromTitle = title.match(/^(.+?)\s+on Instagram:/i)?.[1] || null;
  const handle = parsed.username ? `@${parsed.username}` : twitterTitle.match(/\(@([^)]+)\)/)?.[1] ? `@${twitterTitle.match(/\(@([^)]+)\)/)?.[1]}` : null;
  const finalUrl = canonicalUrl;
  const entityType = inferEntityType(finalUrl);
  const author = {
    name: usernameFromTitle || (handle ? handle.slice(1) : null),
    handle,
    url: handle ? `https://www.instagram.com/${handle.slice(1)}/` : null,
  };

  // Opt-in comment fetching: pass --max-comments N. HTTP meta only gives the
  // comment *count*, so we use a stealth browser to scrape the comment text.
  const maxComments = Math.min(Math.max(Number(options.maxComments) || 0, 0), 50);
  let comments = [];
  let commentsFetched = false;
  if (maxComments > 0) {
    try {
      const raw = await extractPostCommentsFromBrowser(finalUrl, options, manager, maxComments);
      const authorHandle = handle ? handle.slice(1) : null;
      comments = raw
        // drop the leading item when it's the author's own caption, not a comment
        .filter((c, i) => !(i === 0 && authorHandle && c.username === authorHandle))
        .slice(0, maxComments)
        .map((c) => ({
          id: null,
          text: c.text,
          publishedAt: null,
          author: {
            name: c.username,
            handle: `@${c.username}`,
            url: `https://www.instagram.com/${c.username}/`,
          },
          score: null,
        }));
      commentsFetched = true;
    } catch {
      // Best-effort: leave comments empty if the browser fetch is blocked.
    }
  }

  const content = {
    entityType,
    title: buildSyntheticTitle(entityType, author),
    author,
    publishedAt: parsed.publishedAt || null,
    text: parsed.caption || "",
    stats: {
      likeCount: parsed.likes,
      commentCount: parsed.comments,
    },
    media: image
      ? [
          {
            type: "image",
            url: image,
          },
        ]
      : [],
    outboundLinks: [],
    comments,
    platform: {
      site: "instagram",
      canonicalUrl,
      pathType: inferEntityType(finalUrl),
    },
  };

  const format = options.format || "json";
  return createFetchResponse(
    "instagram",
    url,
    finalUrl,
    snapshotDateUtc(),
    format,
    format === "markdown" ? buildMarkdownContent(content, finalUrl) : content,
    {
      startedAt,
      warnings: [],
      blocked: false,
      extraction: {
        method: commentsFetched && comments.length ? "instagram_public_meta+comments_browser" : "instagram_public_meta",
        confidence: image || description ? "medium" : "low",
      },
    }
  );
}
