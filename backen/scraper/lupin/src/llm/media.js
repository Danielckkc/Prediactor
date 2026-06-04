import { getYtDlpStatus, getFfmpegStatus, runSubprocess } from "../runtime/video-deps.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAX_COMPRESSED_SIZE = 20 * 1024 * 1024; // 20 MB

export function isGeminiModel(model) {
  return /gemini/i.test(model || "");
}

/**
 * Check if a model is known to support multimodal (vision/video) input.
 * Conservative: only returns true for models we've tested or that are
 * documented as multimodal. Unknown models return false to avoid sending
 * media to text-only endpoints (which would cause HTTP 400).
 */
export function isMultimodalModel(model) {
  if (!model) return false;
  const lower = model.toLowerCase();
  // Gemini models: native vision + video
  if (lower.includes("gemini")) return true;
  // GPT-4o and variants: vision support
  if (lower.includes("gpt-4o")) return true;
  // Claude models with vision
  if (lower.includes("claude") && !lower.includes("claude-2")) return true;
  // Qwen vision models
  if (lower.includes("qwen") && (lower.includes("vl") || lower.includes("3.5"))) return true;
  // Llama vision models
  if (lower.includes("llama") && lower.includes("vision")) return true;
  return false;
}

export function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    return /^(www\.)?youtube\.com$/.test(parsed.hostname) || parsed.hostname === "youtu.be";
  } catch {
    return false;
  }
}

async function downloadImage(imageUrl) {
  const response = await globalThis.fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const mime = contentType.split(";")[0].trim();
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mime };
}

async function downloadAndCompressVideo(sourceUrl, stateDir) {
  const ytdlpStatus = getYtDlpStatus({ stateDir });
  if (!ytdlpStatus.ok) {
    throw new Error("yt-dlp not installed");
  }
  const ffmpegStatus = getFfmpegStatus({ stateDir });
  if (!ffmpegStatus.ok) {
    throw new Error("ffmpeg not installed");
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lupin-media-"));
  const rawPath = path.join(tmpDir, "raw.mp4");
  const compressedPath = path.join(tmpDir, "compressed.mp4");

  try {
    // Download with yt-dlp
    const ytdlpArgs = [
      sourceUrl,
      "--no-playlist",
      "-o", rawPath,
      "--merge-output-format", "mp4",
    ];
    if (ffmpegStatus.binPath) {
      ytdlpArgs.push("--ffmpeg-location", path.dirname(ffmpegStatus.binPath));
    }
    await runSubprocess(ytdlpStatus.binPath, ytdlpArgs, { timeoutMs: 300_000 });

    // Compress with ffmpeg
    const ffmpegBin = ffmpegStatus.binPath;
    await runSubprocess(ffmpegBin, [
      "-y", "-i", rawPath,
      "-vf", "scale=480:-2",
      "-b:v", "500k",
      "-b:a", "64k",
      "-f", "mp4",
      compressedPath,
    ], { timeoutMs: 300_000 });

    const stat = await fs.stat(compressedPath);
    if (stat.size > MAX_COMPRESSED_SIZE) {
      throw new Error(`Compressed video too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 20MB limit)`);
    }

    const buffer = await fs.readFile(compressedPath);
    return buffer;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resolve provider media[] into OpenAI-compatible content parts.
 *
 * @param {Array} media - Media items from provider result (e.g., [{ type: "image", url: "..." }])
 * @param {object} opts
 * @param {string} opts.model - LLM model name (for Gemini detection)
 * @param {string} opts.stateDir - State directory (for yt-dlp/ffmpeg paths)
 * @param {string} [opts.sourceUrl] - Original fetch URL (for YouTube direct passthrough)
 * @param {string} [opts.entityType] - Entity type from provider result (e.g., "video")
 * @returns {Promise<Array>} OpenAI-compatible content parts
 */
export async function resolveMedia(media, { model, stateDir, sourceUrl, entityType } = {}) {
  if (!media || media.length === 0) return [];

  const parts = [];
  const gemini = isGeminiModel(model);
  const youtubeSource = sourceUrl && isYouTubeUrl(sourceUrl);
  const hasVideoItem = media.some((m) => m.type === "video");

  // YouTube special case: entityType is "video" but media[] only has thumbnail.
  // For Gemini, pass the YouTube URL directly as video.
  if (gemini && youtubeSource && (entityType === "video" || hasVideoItem)) {
    parts.push({
      type: "video_url",
      video_url: { url: sourceUrl },
    });
  }

  // Non-Gemini + video source: download and compress.
  // Only trigger when media[] explicitly contains a video item — don't download
  // just because entityType is "video" (e.g., YouTube returns entityType "video"
  // with only a thumbnail in media[]).
  if (!gemini && hasVideoItem && sourceUrl) {
    try {
      const buffer = await downloadAndCompressVideo(sourceUrl, stateDir);
      const b64 = buffer.toString("base64");
      parts.push({
        type: "video_url",
        video_url: { url: `data:video/mp4;base64,${b64}` },
      });
    } catch (error) {
      if (error.message.includes("not installed")) {
        process.stderr.write(
          `Warning: Video media skipped — run 'lupin setup --with-video' to enable video extraction.\n`
        );
      } else {
        process.stderr.write(
          `Warning: Video media skipped — ${error.message}\n`
        );
      }
    }
  }

  // Process image items (all providers, all models)
  for (const item of media) {
    if (item.type !== "image" || !item.url) continue;

    try {
      const { buffer, mime } = await downloadImage(item.url);
      const b64 = buffer.toString("base64");
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` },
      });
    } catch (error) {
      process.stderr.write(
        `Warning: Image skipped (${item.url.substring(0, 60)}...) — ${error.message}\n`
      );
    }
  }

  return parts;
}
