import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { userAgent } from "../../version.js";

const YOUTUBE_BASE_URL = "https://www.youtube.com";
const DEFAULT_HEADERS = {
  "User-Agent": userAgent,
};

function extractPlayerResponse(html) {
  const match =
    html.match(/var ytInitialPlayerResponse = (.*?);var meta/s) ||
    html.match(/var ytInitialPlayerResponse = (.*?);<\/script>/s);
  if (!match) {
    throw new Error("YouTube watch page did not expose ytInitialPlayerResponse");
  }
  return JSON.parse(match[1]);
}

function extractInitialData(html) {
  const match =
    html.match(/var ytInitialData = (.*?);<\/script>/s) ||
    html.match(/window\["ytInitialData"\] = (.*?);<\/script>/s);
  if (!match) {
    return null;
  }
  return JSON.parse(match[1]);
}

function normalizeThumbnail(thumbnails) {
  const list = Array.isArray(thumbnails) ? thumbnails : [];
  const last = list[list.length - 1];
  return last
    ? {
        type: "image",
        url: last.url,
      }
    : null;
}

function getCaptionTracks(playerResponse) {
  return (
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.map((track) => ({
      languageCode: track.languageCode || null,
      name: track.name?.simpleText || track.name?.runs?.map((run) => run.text || "").join("") || null,
      url: track.baseUrl || null,
      kind: track.kind || null,
    })) || []
  );
}

function buildMarkdownContent(content, finalUrl) {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.author?.name) lines.push(content.author.name);
  if (content.publishedAt) lines.push(content.publishedAt);
  if (content.text) lines.push(content.text);
  if (content.stats) {
    const statLines = Object.entries(content.stats)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    if (statLines.length) lines.push(statLines.join("\n"));
  }
  if (content.platform?.captionTracks?.length) {
    lines.push(
      `Captions: ${content.platform.captionTracks
        .map((track) => `${track.languageCode || "unknown"}${track.kind ? ` (${track.kind})` : ""}`)
        .join(", ")}`
    );
  }

  return renderPageMarkdown({
    title: content.title || "YouTube Video",
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}

export async function fetchYoutubeVideo(scraper, url, options = {}) {
  const startedAt = Date.now();
  const fetcher = scraper?.fetch ? scraper.fetch.bind(scraper) : fetch;
  const response = await fetcher(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`YouTube watch fetch failed with status ${response.status}`);
  }

  const html = await response.text();
  const player = extractPlayerResponse(html);
  const initialData = extractInitialData(html);
  const video = player.videoDetails || {};
  const microformat = player.microformat?.playerMicroformatRenderer || {};
  const captionTracks = getCaptionTracks(player);
  const finalUrl = `${YOUTUBE_BASE_URL}/watch?v=${video.videoId}`;

  const content = {
    entityType: "video",
    title: video.title || null,
    author: {
      name: video.author || null,
      handle: null,
      url: video.channelId ? `${YOUTUBE_BASE_URL}/channel/${video.channelId}` : null,
    },
    publishedAt: microformat.publishDate || microformat.uploadDate || null,
    text: video.shortDescription || microformat.description?.simpleText || "",
    stats: {
      viewCount: video.viewCount ? Number(video.viewCount) : null,
      durationSeconds: video.lengthSeconds ? Number(video.lengthSeconds) : null,
      isLive: Boolean(video.isLiveContent),
    },
    media: [normalizeThumbnail(video.thumbnail?.thumbnails || microformat.thumbnail?.thumbnails)].filter(Boolean),
    outboundLinks: [microformat.embed?.iframeUrl].filter(Boolean),
    comments: [],
    platform: {
      site: "youtube",
      videoId: video.videoId || null,
      channelId: video.channelId || null,
      keywords: Array.isArray(video.keywords) ? video.keywords : [],
      captionTracks,
      category: microformat.category || null,
      isUnlisted: Boolean(microformat.isUnlisted),
      embedUrl: microformat.embed?.iframeUrl || null,
      relatedCount:
        initialData?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results?.length || 0,
    },
  };

  const format = options.format || "json";
  return createFetchResponse(
    "youtube",
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
        method: "youtube_page_embedded_json",
        confidence: "high",
      },
    }
  );
}
