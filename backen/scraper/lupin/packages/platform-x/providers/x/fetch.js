import { BrowserManager } from "lupin-cli/runtime/browser-manager";
import { renderPageMarkdown } from "lupin-cli/runtime/render-structured";
import { createFetchResponse } from "lupin-cli/providers/base/result-shapes";
import { randomDelay, snapshotDateUtc } from "lupin-cli/providers/base/fallbacks";

function trim(value) {
  return String(value || "").trim();
}

function isXLoginShell(text) {
  return /don’t miss what’s happening|don't miss what's happening|new to x\?|sign up now to get your own personalized timeline/i.test(
    text
  );
}

function isXMissingPage(text) {
  return /hmm\.\.\.this page doesn’t exist|hmm\.\.\.this page doesn't exist/i.test(text);
}

function buildMarkdownContent(payload, url) {
  const lines = [];
  if (payload.author?.name || payload.author?.handle) {
    lines.push(`${payload.author?.name || ""} ${payload.author?.handle || ""}`.trim());
  }
  if (payload.publishedAt) {
    lines.push(payload.publishedAt);
  }
  if (payload.text) {
    lines.push(payload.text);
  }
  if (payload.media?.length) {
    lines.push(`Media: ${payload.media.map((item) => item.type + (item.url ? ` ${item.url}` : "")).join(", ")}`);
  }
  if (payload.comments?.length) {
    lines.push(
      `Comments:\n${payload.comments
        .map((comment, index) => `${index + 1}. ${[comment.author?.name, comment.author?.handle].filter(Boolean).join(" ")}${comment.publishedAt ? `, ${comment.publishedAt}` : ""}: ${comment.text}`.trim())
        .join("\n")}`
    );
  }

  return renderPageMarkdown({
    title: payload.title || "X Post",
    url,
    text: lines.filter(Boolean).join("\n\n"),
    links: [],
  });
}

function createEmptyPayload(url, title, rawText) {
  return {
    entityType: "post",
    title: title || null,
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
      site: "x",
      commentCountVisible: false,
    },
    rawText,
    sourceUrl: url,
  };
}

function normalizeCount(value) {
  const text = trim(value).replace(/\s+/g, " ");
  return text || null;
}

async function extractXDomPayload(page, url) {
  return page.evaluate((pageUrl) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const collectText = (node) => normalize(node?.innerText || node?.textContent || "");
    const toAbsolute = (href) => {
      if (!href) return null;
      try {
        return new URL(href, window.location.href).href;
      } catch {
        return href;
      }
    };

    const article = document.querySelector("article");
    const rawText = collectText(document.body);
    if (!article) {
      return {
        found: false,
        rawText,
      };
    }

    const articleText = article.innerText || article.textContent || "";
    const parsed = (() => {
      const lines = String(articleText || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const handleIndex = lines.findIndex((line) => /^@[A-Za-z0-9_]{1,20}$/.test(line));
      const handle = handleIndex >= 0 ? lines[handleIndex] : null;
      const authorName = handleIndex > 0 ? lines[handleIndex - 1] : null;
      const timestampIndex = lines.findIndex(
        (line) => /\b(?:AM|PM)\b/i.test(line) && /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(line)
      );
      const publishedAt = timestampIndex >= 0 ? lines[timestampIndex] : null;
      const textStart = handleIndex >= 0 ? handleIndex + 1 : 0;
      const textEnd = timestampIndex >= 0 ? timestampIndex : lines.length;
      const text = lines
        .slice(textStart, textEnd)
        .filter((line) => line !== "·")
        .join("\n")
        .trim();
      const viewsIndex = lines.findIndex((line) => /^views?$/i.test(line));
      const views = viewsIndex > 0 ? lines[viewsIndex - 1] : null;
      const tail = viewsIndex >= 0 ? lines.slice(viewsIndex + 1) : timestampIndex >= 0 ? lines.slice(timestampIndex + 1) : [];
      const numericTail = tail.filter((line) => /^[\d.,KMB]+$/i.test(line));
      return {
        authorName,
        handle,
        publishedAt,
        text,
        views,
        comments: numericTail[0] || null,
        reposts: numericTail[1] || null,
        likes: numericTail[2] || null,
        bookmarks: numericTail[3] || null,
      };
    })();

    const authorLink = parsed.handle ? `https://x.com/${parsed.handle.slice(1)}` : null;
    const timeElement = article.querySelector("time");
    const tweetTextNode = article.querySelector('[data-testid="tweetText"]');
    const tweetText = String(tweetTextNode?.innerText || "").trim() || parsed.text;

    const statByTestId = Object.fromEntries(
      ["reply", "retweet", "like", "bookmark"].map((testId) => {
        const button = article.querySelector(`[data-testid="${testId}"]`);
        return [testId, normalize(button?.innerText)];
      })
    );

    const viewAnchor = article.querySelector('a[href$="/analytics"]');
    const viewText = normalize(viewAnchor?.textContent);

    const media = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img, img[alt="Image"], video'))
      .map((node) => {
        if (node instanceof HTMLVideoElement) {
          const mediaItem = {
            type: "video",
            url: node.currentSrc || node.src || null,
          };
          if (node.poster) {
            mediaItem.poster = node.poster;
          }
          return mediaItem;
        }

        const src = node.getAttribute("src") || null;
        return {
          type: "image",
          url: src,
        };
      })
      .map((item) => ({
        ...item,
        url: item.type === "image" ? normalize(item.url).replace(/([?&])name=[^&]+/i, "$1name=orig") : item.url,
      }))
      .filter((item) => item.url)
      .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index);

    const articles = Array.from(document.querySelectorAll("article"));
    const comments = articles
      .slice(1)
      .map((replyArticle) => {
        const replyHandle =
          Array.from(replyArticle.querySelectorAll('a[href^="/"]'))
            .map((anchor) => normalize(anchor.textContent))
            .find((value) => /^@[A-Za-z0-9_]{1,20}$/.test(value)) || null;
        const replyName = normalize(
          replyArticle.querySelector('[data-testid="User-Name"] [dir="ltr"] span')?.textContent ||
            replyArticle.querySelector('[data-testid="User-Name"] span')?.textContent
        );
        const replyText = collectText(replyArticle.querySelector('[data-testid="tweetText"]'));
        const replyTime = replyArticle.querySelector("time");
        if (!replyHandle || !replyText) return null;
        return {
          author: {
            name: replyName || null,
            handle: replyHandle,
            url: `https://x.com/${replyHandle.slice(1)}`,
          },
          publishedAt: normalize(replyTime?.textContent),
          publishedAtIso: replyTime?.getAttribute("datetime") || null,
          text: replyText,
        };
      })
      .filter(Boolean);

    return {
      found: true,
      url: window.location.href,
      title: document.title || null,
      rawText,
      author: {
        name: parsed.authorName || null,
        handle: parsed.handle || null,
        url: authorLink || null,
      },
      publishedAt: parsed.publishedAt || normalize(timeElement?.textContent),
      publishedAtIso: timeElement?.getAttribute("datetime") || null,
      text: tweetText,
      stats: {
        commentCount: statByTestId.reply || parsed.comments || null,
        repostCount: statByTestId.retweet || parsed.reposts || null,
        likeCount: statByTestId.like || parsed.likes || null,
        bookmarkCount: statByTestId.bookmark || parsed.bookmarks || null,
        viewCount: viewText || parsed.views || null,
      },
      media,
      comments,
      outboundLinks: Array.from(article.querySelectorAll('a[href]'))
        .map((anchor) => toAbsolute(anchor.getAttribute("href")))
        .filter(Boolean)
        .filter((href) => href !== pageUrl)
        .slice(0, 20),
    };
  }, url);
}

export async function fetchXPost(scraper, url, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const format = options.format || "json";
  const session = await manager.openSession({
    engine: "camoufox",
    timeout: options.timeout || 45000,
  });

  try {
    const pageTimeout = options.timeout || 45000;
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: pageTimeout,
    });

    // Wait for primary tweet OR detect missing page early
    await Promise.race([
      session.page.waitForFunction(
        () => {
          // Check article first — it's the success signal
          const article = document.querySelector("article");
          if (article) {
            if (!article.querySelector("time")) return false;
            const text = article.innerText || "";
            return /@[A-Za-z0-9_]{1,20}/.test(text) && text.length > 50;
          }
          // No article — only bail on definitive "page gone" signal
          const bodyText = document.body?.innerText || "";
          if (/hmm.*this page doesn.t exist/i.test(bodyText)) return true;
          return false;
        },
      ),
      session.page.waitForTimeout(15000),
    ]).catch(() => {});
    await session.page.waitForTimeout(randomDelay(300, 500));

    const domPayload = await extractXDomPayload(session.page, url);
    const rawText = domPayload.rawText || "";
    const loginShell = isXLoginShell(rawText);
    const missing = isXMissingPage(rawText);
    const hasPrimaryPost = Boolean(domPayload.found && domPayload.author?.handle && trim(domPayload.text));
    const blockedReason = missing ? "missing_page" : hasPrimaryPost ? null : loginShell ? "login_shell" : "extraction_failed";
    const warnings = [];

    if (loginShell && !hasPrimaryPost) {
      warnings.push("X returned a login-gated shell instead of readable public post content.");
    }
    if (missing) {
      warnings.push("X reported that the requested post page does not exist.");
    }
    const payload = hasPrimaryPost
      ? {
          entityType: "post",
          title: domPayload.title,
          author: domPayload.author,
          publishedAt: domPayload.publishedAt || domPayload.publishedAtIso || null,
          publishedAtIso: domPayload.publishedAtIso || null,
          text: domPayload.text,
          stats: {
            commentCount: normalizeCount(domPayload.stats.commentCount),
            repostCount: normalizeCount(domPayload.stats.repostCount),
            likeCount: normalizeCount(domPayload.stats.likeCount),
            bookmarkCount: normalizeCount(domPayload.stats.bookmarkCount),
            viewCount: normalizeCount(domPayload.stats.viewCount),
          },
          media: domPayload.media,
          outboundLinks: domPayload.outboundLinks,
          comments: domPayload.comments,
          platform: {
            site: "x",
          },
          blockedReason,
        }
      : {
          ...createEmptyPayload(session.page.url(), domPayload.title, rawText),
          blockedReason,
        };

    const confidence = blockedReason ? "low" : payload.comments.length ? "high" : payload.media.length || Object.values(payload.stats || {}).some(Boolean) ? "medium" : "low";
    const content = format === "markdown" ? buildMarkdownContent(payload, session.page.url()) : { ...payload, extraction: { method: "camoufox", confidence } };

    return createFetchResponse("x", url, session.page.url(), snapshotDateUtc(), format, content, {
      startedAt,
      warnings,
      blocked: Boolean(blockedReason),
      extraction: {
        method: "camoufox",
        confidence,
      },
    });
  } finally {
    await session.close().catch(() => {});
  }
}
