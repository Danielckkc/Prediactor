import path from "node:path";
import { getYtDlpStatus, getFfmpegStatus, ensureYtDlpFresh, runSubprocess } from "../../runtime/video-deps.js";
import { resolveStateDir } from "../../runtime/config.js";

export function buildYtDlpArgs(url, options = {}) {
  const { ffmpegDir, outputDir, audioOnly, subtitles } = options;
  const outDir = outputDir || process.cwd();
  const outputTemplate = path.join(outDir, "%(title)s [%(id)s].%(ext)s");

  const args = [url, "--print-json", "--progress", "--newline", "--no-playlist", "-o", outputTemplate];

  if (ffmpegDir) {
    args.push("--ffmpeg-location", ffmpegDir);
  }

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3");
  } else {
    args.push("--merge-output-format", "mp4");
  }

  if (subtitles) {
    args.push("--write-subs", "--sub-langs", "all");
  }

  return args;
}

function extractSiteName(extractorKey) {
  if (!extractorKey) return null;
  const lower = extractorKey.toLowerCase();
  if (lower === "youtube") return "youtube";
  if (lower === "tiktok") return "tiktok";
  if (lower === "instagram") return "instagram";
  return lower;
}

function parseUploadDate(uploadDate) {
  if (!uploadDate || uploadDate.length !== 8) return null;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

export function parseYtDlpOutput(json) {
  const basePath = json._filename || json.filename || null;
  const subtitleEntries = json.requested_subtitles
    ? Object.entries(json.requested_subtitles).map(([lang, sub]) => {
        // yt-dlp does not include the subtitle file path in --print-json.
        // Reconstruct it from the video output path: replace the extension
        // with .<lang>.<sub_ext> (matching yt-dlp's naming convention).
        let subPath = sub.filepath || sub.filename || null;
        if (!subPath && basePath) {
          const subExt = sub.ext || "vtt";
          subPath = basePath.replace(/\.[^.]+$/, `.${lang}.${subExt}`);
        }
        return { language: lang, path: subPath };
      })
    : null;

  return {
    entityType: "download",
    title: json.title || null,
    author: {
      name: json.uploader || null,
      url: json.uploader_url || json.channel_url || null,
    },
    publishedAt: parseUploadDate(json.upload_date),
    platform: {
      site: extractSiteName(json.extractor_key),
      videoId: json.id || null,
    },
    file: {
      path: json._filename || json.filename || null,
      sizeBytes: json.filesize || json.filesize_approx || null,
      format: json.ext || null,
      durationSeconds: json.duration ? Math.round(json.duration) : null,
    },
    subtitles: subtitleEntries && subtitleEntries.length > 0 ? subtitleEntries : null,
    thumbnail: json.thumbnail || null,
  };
}

function resolveYtDlpBin(stateDir) {
  const status = getYtDlpStatus({ stateDir });
  if (!status.ok) {
    throw new Error(
      "yt-dlp is not installed. Run: lupin setup --with-video"
    );
  }
  return status.binPath;
}

function resolveFfmpegDir(stateDir) {
  const status = getFfmpegStatus({ stateDir });
  if (!status.ok) {
    throw new Error(
      "FFmpeg is not installed. Run: lupin setup --with-video\n" +
      "Or install FFmpeg manually: brew install ffmpeg (macOS) / apt install ffmpeg (Linux)"
    );
  }
  return path.dirname(status.binPath);
}

export async function downloadVideo(url, options = {}, { stateDir } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("Invalid URL: must start with http:// or https://");
  }

  const resolvedStateDir = stateDir || resolveStateDir();
  const binPath = resolveYtDlpBin(resolvedStateDir);
  const ffmpegDir = resolveFfmpegDir(resolvedStateDir);

  await ensureYtDlpFresh(resolvedStateDir);

  const args = buildYtDlpArgs(url, {
    ffmpegDir,
    outputDir: options.outputDir,
    audioOnly: options.audioOnly,
    subtitles: options.subtitles,
  });

  const timeoutMs =
    options.timeoutMs ||
    Number(process.env.LUPIN_DOWNLOAD_TIMEOUT_MS) ||
    5 * 60 * 1000; // 5 minutes

  // yt-dlp emits download progress on stdout (alongside --print-json).
  // Forward non-JSON stdout lines to the progress handler so the user
  // sees progress during the download. Also forward stderr (warnings).
  const onProgress = options.onProgress;
  const onStdout = onProgress
    ? (chunk) => {
        for (const line of chunk.split("\n")) {
          if (line && !line.startsWith("{")) onProgress(line + "\n");
        }
      }
    : undefined;

  const { stdout } = await runSubprocess(binPath, args, {
    timeoutMs,
    onStderr: onProgress,
    onStdout,
  });

  // With --progress, yt-dlp interleaves the --print-json blob (a single line
  // starting with '{') among [download]/[Merger] progress lines. Find it.
  const lines = stdout.split("\n").filter(Boolean);
  let json;
  for (const line of lines) {
    if (line.startsWith("{")) {
      try { json = JSON.parse(line); break; } catch { /* not the JSON line */ }
    }
  }
  if (!json) {
    throw new Error(`Failed to find yt-dlp JSON metadata in output. Raw output:\n${stdout.slice(0, 500)}`);
  }

  const result = parseYtDlpOutput(json);

  // yt-dlp --print-json reports pre-conversion metadata. When extracting
  // audio, the actual file on disk has a different extension (.mp3 instead
  // of .webm/.m4a). Correct the path and format to match reality.
  if (options.audioOnly && result.file.path) {
    const correctedPath = result.file.path.replace(/\.[^.]+$/, ".mp3");
    result.file.path = correctedPath;
    result.file.format = "mp3";
    result.file.sizeBytes = null; // pre-conversion size is inaccurate
  }

  return result;
}
