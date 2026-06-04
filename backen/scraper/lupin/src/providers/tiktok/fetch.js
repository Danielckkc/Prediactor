import { BrowserManager } from "../../runtime/browser-manager.js";
import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { decodeHtmlEntities } from "../base/html.js";
import { buildProfileMarkdownContent } from "../base/profile.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { randomDelay, snapshotDateUtc } from "../base/fallbacks.js";

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0",
};

function extractUniversalData(html) {
  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/i
  );
  return match ? JSON.parse(decodeHtmlEntities(match[1])) : null;
}

function toIsoDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
}

function buildSyntheticTitle(author) {
  if (author?.handle) {
    return `TikTok video by ${author.handle}`;
  }
  if (author?.name) {
    return `TikTok video by ${author.name}`;
  }
  return "TikTok video";
}

function normalizeMedia(item) {
  const media = [];
  if (item?.video?.playAddr) {
    media.push({
      type: "video",
      url: item.video.playAddr,
      durationSeconds: Number(item.video.duration) || null,
      cover: item.video.originCover || item.video.cover || null,
      dynamicCover: item.video.dynamicCover || null,
    });
  }
  const imageUrl = item?.video?.originCover || item?.video?.cover || null;
  if (imageUrl) {
    media.push({
      type: "image",
      url: imageUrl,
    });
  }
  return media;
}

function normalizeChallenges(textExtra = []) {
  return textExtra
    .filter((entry) => entry?.type === 1 && entry?.hashtagName)
    .map((entry) => `#${entry.hashtagName}`);
}

function buildMarkdownContent(content, finalUrl) {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.author?.handle || content.author?.name) {
    lines.push([content.author?.name, content.author?.handle].filter(Boolean).join(" "));
  }
  if (content.publishedAt) lines.push(content.publishedAt);
  if (content.text) lines.push(content.text);
  if (content.stats) {
    const statLines = Object.entries(content.stats)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${value}`);
    if (statLines.length) lines.push(statLines.join("\n"));
  }
  if (content.platform?.hashtags?.length) {
    lines.push(`Hashtags: ${content.platform.hashtags.join(" ")}`);
  }
  if (content.media?.length) {
    lines.push(`Media: ${content.media.map((item) => item.url).filter(Boolean).join(", ")}`);
  }
  if (content.comments?.length) {
    const commentLines = content.comments.map((comment, i) => {
      let line = `${i + 1}. ${comment.author?.handle || comment.author?.name || "Unknown"}`;
      if (comment.publishedAt) line += `, ${comment.publishedAt}`;
      if (comment.likeCount) line += ` (${comment.likeCount} likes)`;
      line += `: ${comment.text}`;
      if (comment.replies?.length) {
        line += "\n" + comment.replies
          .map((r) =>
            `   \u21b3 ${r.author?.handle || r.author?.name || "Unknown"}${r.publishedAt ? `, ${r.publishedAt}` : ""}${r.likeCount ? ` (${r.likeCount} likes)` : ""}: ${r.text}`
          )
          .join("\n");
      }
      return line;
    });
    lines.push(`Comments:\n${commentLines.join("\n")}`);
  }

  return renderPageMarkdown({
    title: content.title || "TikTok video",
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}

function buildBlockedResponse(url, finalUrl, format, warning, startedAt) {
  return createFetchResponse(
    "tiktok",
    url,
    finalUrl,
    snapshotDateUtc(),
    format,
    {
      entityType: "video",
      title: null,
      author: {
        name: null,
        handle: null,
        url: null,
      },
      publishedAt: null,
      text: "",
      stats: {},
      media: [],
      outboundLinks: [],
      comments: [],
      platform: {
        site: "tiktok",
        canonicalUrl: finalUrl,
      },
    },
    {
      startedAt,
      warnings: [warning],
      blocked: true,
      extraction: {
        method: "tiktok_public_hydration",
        confidence: "low",
      },
    }
  );
}

function getVideoDetail(data) {
  return data?.__DEFAULT_SCOPE__?.["webapp.video-detail"] || null;
}

function buildContent(item, finalUrl) {
  const author = {
    name: item.author?.nickname || null,
    handle: item.author?.uniqueId ? `@${item.author.uniqueId}` : null,
    url: item.author?.uniqueId ? `https://www.tiktok.com/@${item.author.uniqueId}` : null,
  };
  const hashtags = normalizeChallenges(item.textExtra);
  return {
    entityType: "video",
    title: buildSyntheticTitle(author),
    author,
    publishedAt: toIsoDate(item.createTime),
    text: String(item.desc || "").trim(),
    stats: {
      likeCount: item.stats?.diggCount ?? null,
      commentCount: item.stats?.commentCount ?? null,
      shareCount: item.stats?.shareCount ?? null,
      viewCount: item.stats?.playCount ?? null,
      favoriteCount: item.stats?.collectCount ?? null,
    },
    media: normalizeMedia(item),
    outboundLinks: [],
    comments: [],
    platform: {
      site: "tiktok",
      canonicalUrl: finalUrl,
      videoId: item.id || null,
      hashtags,
      music: item.music
        ? {
            id: item.music.id || null,
            title: item.music.title || null,
            authorName: item.music.authorName || null,
            url: item.music.playUrl || null,
          }
        : null,
      durationSeconds: Number(item.video?.duration) || null,
    },
  };
}

async function fetchOembed(url, fetcher = fetch) {
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await fetcher(oembedUrl);
  if (!response.ok) return null;
  return response.json();
}

function parseOembedHashtags(html) {
  const matches = html?.match(/title="([^"]+)" target="_blank" href="[^"]*\/tag\//g) || [];
  return matches.map((m) => {
    const title = m.match(/title="([^"]+)"/)?.[1];
    return title ? `#${title}` : null;
  }).filter(Boolean);
}

function parseMusicFromOembed(html) {
  const match = html?.match(/♬\s*([^<]+)/);
  return match ? match[1].trim() : null;
}

function buildContentFromOembed(oembed, domStats, finalUrl) {
  const handle = oembed.author_unique_id ? `@${oembed.author_unique_id}` : null;
  const author = {
    name: oembed.author_name || null,
    handle,
    url: oembed.author_url || null,
  };
  const hashtags = parseOembedHashtags(oembed.html);
  const musicTitle = parseMusicFromOembed(oembed.html);
  return {
    entityType: "video",
    title: oembed.title || buildSyntheticTitle(author),
    author,
    publishedAt: domStats?.publishedAt || null,
    text: oembed.title || "",
    stats: {
      likeCount: domStats?.likeCount ?? null,
      commentCount: domStats?.commentCount ?? null,
      shareCount: domStats?.shareCount ?? null,
      viewCount: null,
      favoriteCount: domStats?.favoriteCount ?? null,
    },
    media: oembed.thumbnail_url
      ? [{ type: "image", url: oembed.thumbnail_url }]
      : [],
    outboundLinks: [],
    comments: [],
    platform: {
      site: "tiktok",
      canonicalUrl: finalUrl,
      videoId: oembed.embed_product_id || null,
      hashtags,
      music: musicTitle ? { title: musicTitle } : null,
      durationSeconds: domStats?.durationSeconds ?? null,
    },
  };
}

// --- Comment extraction helpers (verified against camoufox DOM) ---
// TikTok desktop: "You may like" tab active by default. Must click "Comments" tab.
// Comment DOM: no data-e2e attributes. "Reply" is <p role="button">, not <button>.
// Like count in <div role="button" aria-label="Like video\n32.4K likes"> > <span>.
// Comment list found via "N comments" header span → parent → parent → children[1].

async function clickCommentsTab(page) {
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const tab = buttons.find((b) => b.textContent.trim() === "Comments");
    if (tab) { tab.click(); return true; }
    return false;
  });
  if (clicked) {
    await page.waitForTimeout(2000);
  }
  return clicked;
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll("button")) {
      const t = btn.textContent.trim().toLowerCase();
      if (t === "decline optional cookies" || t === "got it") btn.click();
    }
    const dialog = document.querySelector("dialog");
    if (dialog) {
      const closeBtn = dialog.querySelector('button[aria-label="Close"]') ||
        Array.from(dialog.querySelectorAll("button")).find((b) =>
          b.textContent.trim().toLowerCase() === "close"
        );
      if (closeBtn) closeBtn.click();
    }
  });
  await page.waitForTimeout(500);
}

async function scrollCommentList(page, targetCount, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let previousCount = 0;
  let stableRounds = 0;

  // Cache the scrollable ancestor of the comment list
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let list = null;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.children.length === 0 && /^\d+ comments?$/i.test(el.textContent.trim())) {
        list = el.parentElement?.parentElement?.children[1];
        break;
      }
    }
    if (!list) return;
    let el = list;
    while (el && el !== document.body) {
      const s = window.getComputedStyle(el);
      if (s.overflowY === "auto" || s.overflowY === "scroll") {
        el.dataset.lupinScroll = "1";
        return;
      }
      el = el.parentElement;
    }
  });

  while (Date.now() < deadline && stableRounds < 3) {
    const currentCount = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (el.children.length === 0 && /^\d+ comments?$/i.test(el.textContent.trim())) {
          return el.parentElement?.parentElement?.children[1]?.children.length || 0;
        }
      }
      return 0;
    });
    if (currentCount >= targetCount) break;
    if (currentCount === previousCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;

    await page.evaluate(() => {
      const el = document.querySelector('[data-lupin-scroll="1"]');
      if (el) { el.scrollTop += 600; } else { window.scrollBy(0, 600); }
    });

    await page.waitForTimeout(randomDelay(800, 1400));
  }
}

async function expandReplies(page, limit) {
  try {
    const count = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .filter((b) => /^View \d+ repl/i.test(b.textContent.trim())).length
    );
    const toClick = Math.min(count, limit);
    for (let i = 0; i < toClick; i++) {
      await page.evaluate((idx) => {
        const buttons = Array.from(document.querySelectorAll("button"))
          .filter((b) => /^View \d+ repl/i.test(b.textContent.trim()));
        if (buttons[idx]) buttons[idx].click();
      }, i);
      await page.waitForTimeout(randomDelay(400, 800));
    }
  } catch {
    // Reply expansion is best-effort
  }
}

async function extractCommentsFromPage(page, options) {
  const maxComments = Math.min(Math.max(Number(options.maxComments) || 10, 0), 50);
  const maxReplies = options.maxRepliesPerComment != null
    ? Math.max(Number(options.maxRepliesPerComment), 0)
    : 1;
  const minLikes = Math.max(Number(options.minCommentLikes) || 0, 0);

  // Step 1: Click "Comments" tab — comments don't load until this is clicked
  const tabClicked = await clickCommentsTab(page);
  if (!tabClicked) return [];

  // Step 2: Wait for comments to render
  // "Reply" is <p role="button">, not <button>, so check for that
  await Promise.race([
    page.waitForFunction(() =>
      !!document.querySelector('p[role="button"][aria-label="Reply"]')
    ),
    page.waitForTimeout(8000),
  ]).catch(() => {});

  // Step 3: Scroll to load more comments
  const loadTarget = minLikes > 0 ? maxComments * 3 : maxComments + 5;
  await scrollCommentList(page, loadTarget);

  // Step 4: Expand replies
  if (maxReplies > 0) {
    await expandReplies(page, loadTarget);
  }

  // Step 5: Extract comment data from DOM
  // Verified structure per comment (camoufox):
  //   container > body > [avatar(a), content > [author(div), TEXT(span>span),
  //     metadata > [time(span) + Reply(p role=button), Like(div role=button > span)]]]
  //   container > replySection > [expandBtn(button "View N replies"), ...]
  const rawComments = await page.evaluate(() => {
    const parseCount = (text) => {
      const cleaned = String(text || "").trim();
      if (!cleaned) return 0;
      const match = cleaned.match(/^([\d.]+)\s*([KMB])?$/i);
      if (!match) return parseInt(cleaned.replace(/\D/g, ""), 10) || 0;
      const num = parseFloat(match[1]);
      const suffix = (match[2] || "").toUpperCase();
      const multipliers = { K: 1000, M: 1000000, B: 1000000000 };
      return Math.round(num * (multipliers[suffix] || 1));
    };

    const extractAuthor = (el) => {
      const links = el.querySelectorAll('a[href^="/@"]');
      if (links.length === 0) return { name: null, handle: null, url: null };
      const nameLink = links[1] || links[0];
      const href = links[0].getAttribute("href") || "";
      const handleMatch = href.match(/@([^/?]+)/);
      return {
        name: (nameLink.textContent || "").trim() || null,
        handle: handleMatch ? `@${handleMatch[1]}` : null,
        url: handleMatch ? `https://www.tiktok.com/@${handleMatch[1]}` : null,
      };
    };

    const extractCommentData = (container) => {
      const profileLinks = container.querySelectorAll('a[href^="/@"]');
      if (profileLinks.length === 0) return null;

      const author = extractAuthor(container);

      // Text: body > content(child 1) > span (comment text)
      // Falls back to searching all spans if structural navigation fails
      const body = container.firstElementChild;
      const content = body?.children?.[1];
      let textSpan = content
        ? Array.from(content.children).find((c) => c.tagName === "SPAN")
        : null;
      if (!textSpan) {
        // Fallback: find a span with substantial text that isn't a like count or timestamp
        const allSpans = container.querySelectorAll("span");
        textSpan = Array.from(allSpans).find((s) => {
          const t = s.textContent.trim();
          return t.length > 3 && !/^\d/.test(t) && s.closest('[role="button"]') === null;
        });
      }
      const text = (textSpan?.textContent || "").trim();

      // Like count: div[role=button][aria-label*="Like video"] > span
      const likeEl = container.querySelector('[role="button"][aria-label*="Like video"]');
      const likeSpan = likeEl?.querySelector("span");
      const likeCount = parseCount(likeSpan?.textContent);

      // Timestamp: grandparent of Reply p has [span(time), div(Reply)]
      const replyP = container.querySelector('p[role="button"][aria-label="Reply"]');
      const metaRow = replyP?.parentElement?.parentElement;
      const timeSpan = metaRow?.querySelector(":scope > span");
      const publishedAt = timeSpan?.textContent?.trim() || null;

      return { author, text, publishedAt, likeCount };
    };

    // Find comment list via "N comments" header
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let commentList = null;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.children.length === 0 && /^\d+ comments?$/i.test(el.textContent.trim())) {
        commentList = el.parentElement?.parentElement?.children[1];
        break;
      }
    }
    if (!commentList) return [];

    return Array.from(commentList.children).map((container) => {
      const comment = extractCommentData(container);
      if (!comment) return null;

      // Replies: second child of container holds reply section
      const replySection = container.children[1];
      const replies = [];
      if (replySection) {
        for (const replyEl of replySection.children) {
          if (replyEl.querySelectorAll('a[href^="/@"]').length === 0) continue;
          const reply = extractCommentData(replyEl);
          if (reply) replies.push(reply);
        }
      }

      return { ...comment, replies };
    }).filter(Boolean);
  });

  return rawComments
    .sort((a, b) => b.likeCount - a.likeCount)
    .filter((c) => c.likeCount >= minLikes)
    .slice(0, maxComments)
    .map((c) => ({
      ...c,
      replies: (c.replies || []).slice(0, maxReplies),
    }));
}

async function extractFromBrowser(url, options, manager) {
  const maxComments = Math.max(Number(options.maxComments) || 0, 0);
  const pageTimeout = options.timeout || 45000;
  const session = await manager.openSession({
    engine: "camoufox",
    timeout: pageTimeout,
  });

  try {
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: pageTimeout,
    });

    // Mute video audio immediately
    await session.page.evaluate(() => {
      document.querySelectorAll("video, audio").forEach((el) => {
        el.muted = true;
      });
    });

    // Dismiss cookie consent, GDPR notices, captcha dialogs
    await dismissOverlays(session.page);

    await Promise.race([
      session.page.waitForFunction(
        () => !!document.querySelector('[data-e2e="like-count"]')
      ),
      session.page.waitForTimeout(8000),
    ]).catch(() => {});

    // Re-mute in case new video elements were created
    await session.page.evaluate(() => {
      document.querySelectorAll("video, audio").forEach((el) => {
        el.muted = true;
      });
    });

    const stats = await session.page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || "").trim() : null;
      };

      const article = document.querySelector('[data-e2e="recommend-list-item-container"]');
      const articleText = article?.innerText || "";

      const durationMatch = articleText.match(/(\d{2}:\d{2})\s*\/\s*(\d{2}:\d{2})/);
      let durationSeconds = null;
      if (durationMatch) {
        const [m, s] = durationMatch[2].split(":").map(Number);
        durationSeconds = m * 60 + s;
      }

      const dateMatch = articleText.match(/·\s*(\d{1,2}-\d{1,2})/);
      const publishedAt = dateMatch ? dateMatch[1] : null;

      return {
        likeCount: txt('[data-e2e="like-count"]'),
        commentCount: txt('[data-e2e="comment-count"]'),
        shareCount: txt('[data-e2e="share-count"]'),
        favoriteCount: txt('[data-e2e="undefined-count"]'),
        durationSeconds,
        publishedAt,
      };
    });

    const comments = maxComments > 0
      ? await extractCommentsFromPage(session.page, options)
      : [];

    return { stats, comments };
  } finally {
    await session.close().catch(() => {});
  }
}

function getUserDetail(data) {
  return data?.__DEFAULT_SCOPE__?.["webapp.user-detail"] || null;
}

function buildProfileContent(userInfo, finalUrl, latestPosts = []) {
  const user = userInfo.user || {};
  const stats = userInfo.statsV2 || userInfo.stats || {};
  const author = {
    name: user.nickname || null,
    handle: user.uniqueId ? `@${user.uniqueId}` : null,
    url: user.uniqueId ? `https://www.tiktok.com/@${user.uniqueId}` : null,
  };
  return {
    entityType: "profile",
    title: user.nickname ? `${user.nickname} (${author.handle})` : author.handle || "TikTok Profile",
    author,
    publishedAt: null,
    text: String(user.signature || "").trim(),
    stats: {
      followerCount: stats.followerCount ?? null,
      followingCount: stats.followingCount ?? null,
      likeCount: stats.heartCount ?? stats.heart ?? null,
      videoCount: stats.videoCount ?? null,
    },
    media: user.avatarLarger
      ? [{ type: "image", url: user.avatarLarger }]
      : [],
    latestPosts,
    outboundLinks: [],
    comments: [],
    platform: {
      site: "tiktok",
      canonicalUrl: finalUrl,
      username: user.uniqueId || null,
      isVerified: user.verified || false,
      isPrivate: user.privateAccount || false,
    },
  };
}

export async function fetchTiktokProfile(_scraper, url, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const format = options.format || "json";
  const pageTimeout = options.timeout || 30000;

  // TikTok profiles return a JS shell via HTTP — must use browser
  const session = await manager.openSession({
    engine: "camoufox",
    timeout: pageTimeout,
  });

  try {
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: pageTimeout,
    });

    // Dismiss overlays and wait for profile data in parallel
    await Promise.all([
      dismissOverlays(session.page),
      Promise.race([
        session.page.waitForFunction(
          () => !!document.querySelector('[data-e2e="followers-count"]') &&
                document.querySelectorAll('a[href*="/video/"]').length > 0
        ),
        session.page.waitForTimeout(8000),
      ]).catch(() => {}),
    ]);

    // Single evaluate: extract rehydration data + video links together
    const { rehydrationData, videoLinks } = await session.page.evaluate(() => {
      const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      let rehydrationData = null;
      try { if (el) rehydrationData = JSON.parse(el.textContent); } catch {}
      const videoLinks = [...new Set(
        [...document.querySelectorAll('a[href*="/video/"]')].map((a) => a.href)
      )];
      return { rehydrationData, videoLinks };
    });
    const latestPosts = videoLinks.slice(0, 12).map((videoUrl) => ({ url: videoUrl, type: "video" }));

    const userDetail = getUserDetail(rehydrationData);

    if (userDetail?.userInfo?.user) {
      const finalUrl = userDetail.userInfo.user.uniqueId
        ? `https://www.tiktok.com/@${userDetail.userInfo.user.uniqueId}`
        : url;
      const content = buildProfileContent(userDetail.userInfo, finalUrl, latestPosts);

      return createFetchResponse(
        "tiktok",
        url,
        finalUrl,
        snapshotDateUtc(),
        format,
        format === "markdown" ? buildProfileMarkdownContent(content, finalUrl, "TikTok") : content,
        {
          startedAt,
          warnings: [],
          blocked: false,
          extraction: {
            method: "tiktok_profile_hydration",
            confidence: "high",
          },
        }
      );
    }

    // Rehydration failed — fall back to DOM extraction
    const domProfile = await session.page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || "").trim() : null;
      };
      return {
        nickname: txt('h1[data-e2e="user-subtitle"]') || txt('h2[data-e2e="user-subtitle"]'),
        handle: txt('h1[data-e2e="user-title"]') || txt('h2[data-e2e="user-title"]'),
        bio: txt('[data-e2e="user-bio"]'),
        followers: txt('[data-e2e="followers-count"]'),
        following: txt('[data-e2e="following-count"]'),
        likes: txt('[data-e2e="likes-count"]'),
        avatar: document.querySelector('img[class*="Avatar"]')?.src || null,
        isVerified: !!document.querySelector('[data-e2e="verify-badge"]'),
      };
    });

    if (!domProfile.handle && !domProfile.nickname) {
      return createFetchResponse(
        "tiktok",
        url,
        url,
        snapshotDateUtc(),
        format,
        {
          entityType: "profile",
          title: null,
          author: { name: null, handle: null, url: null },
          publishedAt: null,
          text: "",
          stats: {},
          media: [],
          latestPosts: [],
          outboundLinks: [],
          comments: [],
          platform: { site: "tiktok", canonicalUrl: url },
        },
        {
          startedAt,
          warnings: ["TikTok profile data could not be extracted."],
          blocked: true,
          extraction: {
            method: "tiktok_profile_dom",
            confidence: "low",
          },
        }
      );
    }

    const handle = domProfile.handle ? `@${domProfile.handle.replace(/^@/, "")}` : null;
    const finalUrl = handle ? `https://www.tiktok.com/${handle}` : url;
    const content = {
      entityType: "profile",
      title: domProfile.nickname ? `${domProfile.nickname} (${handle})` : handle || "TikTok Profile",
      author: {
        name: domProfile.nickname || null,
        handle,
        url: finalUrl,
      },
      publishedAt: null,
      text: domProfile.bio || "",
      stats: {
        followerCount: domProfile.followers,
        followingCount: domProfile.following,
        likeCount: domProfile.likes,
        videoCount: null,
      },
      media: domProfile.avatar ? [{ type: "image", url: domProfile.avatar }] : [],
      latestPosts,
      outboundLinks: [],
      comments: [],
      platform: {
        site: "tiktok",
        canonicalUrl: finalUrl,
        username: domProfile.handle?.replace(/^@/, "") || null,
        isVerified: domProfile.isVerified,
        isPrivate: false,
      },
    };

    return createFetchResponse(
      "tiktok",
      url,
      finalUrl,
      snapshotDateUtc(),
      format,
      format === "markdown" ? buildProfileMarkdownContent(content, finalUrl, "TikTok") : content,
      {
        startedAt,
        warnings: [],
        blocked: false,
        extraction: {
          method: "tiktok_profile_dom",
          confidence: domProfile.followers ? "medium" : "low",
        },
      }
    );
  } finally {
    await session.close().catch(() => {});
  }
}

export async function fetchTiktokPost(scraper, url, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const format = options.format || "json";
  const fetcher = scraper?.fetch ? scraper.fetch.bind(scraper) : fetch;
  const response = await fetcher(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`TikTok fetch failed with status ${response.status}`);
  }

  const finalUrl = response.url || url;
  const html = await response.text();
  let data = extractUniversalData(html);
  let detail = getVideoDetail(data);
  let effectiveFinalUrl = finalUrl;
  let usedBrowserFallback = false;

  if (!detail?.itemInfo?.itemStruct || Number(detail?.statusCode) !== 0) {
    // Rehydration failed — check oEmbed first (fast, tells us if video exists)
    const oembed = await fetchOembed(url, fetcher).catch(() => null);

    if (!oembed) {
      return buildBlockedResponse(
        url,
        effectiveFinalUrl,
        format,
        detail?.statusMsg || "TikTok video is unavailable.",
        startedAt
      );
    }

    // oEmbed worked — enrich with DOM stats + comments from camoufox
    const browser = await extractFromBrowser(url, options, manager).catch(() => null);
    const domStats = browser?.stats || null;
    const content = buildContentFromOembed(oembed, domStats, effectiveFinalUrl);
    content.comments = browser?.comments || [];
    const hasStats = domStats && Object.values(domStats).some(Boolean);

    return createFetchResponse(
      "tiktok",
      url,
      effectiveFinalUrl,
      snapshotDateUtc(),
      format,
      format === "markdown" ? buildMarkdownContent(content, effectiveFinalUrl) : content,
      {
        startedAt,
        warnings: [],
        blocked: false,
        extraction: {
          method: hasStats ? "oembed_dom" : "oembed",
          confidence: hasStats ? "high" : "medium",
        },
      }
    );
  }

  const item = detail.itemInfo.itemStruct;
  const content = buildContent(item, effectiveFinalUrl);

  const maxComments = Math.max(Number(options.maxComments) || 0, 0);
  if (maxComments > 0) {
    const browser = await extractFromBrowser(url, options, manager).catch(() => null);
    content.comments = browser?.comments || [];
  }

  return createFetchResponse(
    "tiktok",
    url,
    effectiveFinalUrl,
    snapshotDateUtc(),
    format,
    format === "markdown" ? buildMarkdownContent(content, effectiveFinalUrl) : content,
    {
      startedAt,
      warnings: [],
      blocked: false,
      extraction: {
        method: "tiktok_public_hydration",
        confidence: content.media.length ? "high" : "medium",
      },
    }
  );
}
