import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { resolveStateDir } from "./config.js";
import { userAgent } from "../version.js";

const STALE_THRESHOLD_DAYS = Number(process.env.LUPIN_YTDLP_UPDATE_DAYS || 14);

const YTDLP_ASSET_MAP = {
  "darwin-arm64": "yt-dlp_macos",
  "darwin-x64": "yt-dlp_macos",
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
  "win32-x64": "yt-dlp.exe",
};

const FFMPEG_ASSET_MAP = {
  "darwin-arm64": "ffmpeg-darwin-arm64.gz",
  "darwin-x64": "ffmpeg-darwin-x64.gz",
  "linux-x64": "ffmpeg-linux-x64.gz",
  "linux-arm64": "ffmpeg-linux-arm64.gz",
  "win32-x64": "ffmpeg-win32-x64.gz",
};

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

export function getYtDlpAssetName(platform, arch) {
  const key = `${platform}-${arch}`;
  const asset = YTDLP_ASSET_MAP[key];
  if (!asset) throw new Error(`Unsupported platform for yt-dlp: ${key}`);
  return asset;
}

export function getFfmpegAssetName(platform, arch) {
  const key = `${platform}-${arch}`;
  const asset = FFMPEG_ASSET_MAP[key];
  if (!asset) throw new Error(`Unsupported platform for FFmpeg: ${key}`);
  return asset;
}

export function getVideoBinDir(stateDir) {
  return path.join(stateDir, "bin");
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function computeStaleDays(installedAt) {
  if (!installedAt) return null;
  const diff = Date.now() - new Date(installedAt).getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function findInPath(binaryName) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, [binaryName], { encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function httpsGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { "User-Agent": userAgent } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
        resolve(httpsGet(res.headers.location, maxRedirects - 1));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

export function runSubprocess(command, args, { timeoutMs, onStderr, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timer;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (onStdout) onStdout(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (onStderr) onStderr(chunk.toString());
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });

    if (timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }
  });
}

async function fetchLatestYtDlpRelease() {
  const res = await httpsGet("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const release = JSON.parse(Buffer.concat(chunks).toString());
  return { tag: release.tag_name, assets: release.assets };
}

async function downloadFile(url, destPath) {
  const res = await httpsGet(url);
  await pipeline(res, createWriteStream(destPath));
}

async function downloadGzipFile(url, destPath) {
  const res = await httpsGet(url);
  await pipeline(res, createGunzip(), createWriteStream(destPath));
}

// ---------------------------------------------------------------------------
// Status exports
// ---------------------------------------------------------------------------

export function getYtDlpStatus({ stateDir } = {}) {
  const envPath = process.env.LUPIN_YTDLP_PATH;
  if (envPath) {
    return {
      ok: true,
      version: null,
      installedAt: null,
      stale: false,
      staleDays: null,
      source: "env",
      binPath: envPath,
      message: `yt-dlp configured via LUPIN_YTDLP_PATH (${envPath}).`,
      fixCommand: null,
    };
  }

  const resolvedStateDir = stateDir || resolveStateDir();
  const binDir = getVideoBinDir(resolvedStateDir);
  const binName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const binPath = path.join(binDir, binName);
  const metaPath = path.join(binDir, "yt-dlp-meta.json");

  if (!fs.existsSync(binPath)) {
    return {
      ok: false,
      version: null,
      installedAt: null,
      stale: false,
      staleDays: 0,
      source: "missing",
      binPath: null,
      message: "yt-dlp is not installed.",
      fixCommand: "lupin setup --with-video",
    };
  }

  const meta = readJsonSafe(metaPath);
  const version = meta?.version || null;
  const installedAt = meta?.installedAt || null;
  const staleDays = computeStaleDays(installedAt);
  const stale = staleDays === null || staleDays >= STALE_THRESHOLD_DAYS;
  const versionLabel = version || "unknown version";

  let message;
  if (staleDays === null) {
    message = `yt-dlp ${versionLabel} is installed (install date unknown, will auto-update on next download).`;
  } else {
    const ageLabel = staleDays === 0 ? "today" : staleDays === 1 ? "1 day ago" : `${staleDays} days ago`;
    message = stale
      ? `yt-dlp ${versionLabel} installed ${ageLabel} (stale, auto-update on next download).`
      : `yt-dlp ${versionLabel} installed ${ageLabel}.`;
  }

  return {
    ok: true,
    version,
    installedAt,
    stale,
    staleDays,
    source: "managed",
    binPath,
    message,
    fixCommand: null,
  };
}

export function getFfmpegStatus({ stateDir, skipSystemCheck } = {}) {
  const envPath = process.env.LUPIN_FFMPEG_PATH;
  if (envPath) {
    return {
      ok: true,
      version: null,
      source: "env",
      binPath: envPath,
      message: `FFmpeg configured via LUPIN_FFMPEG_PATH (${envPath}).`,
      fixCommand: null,
    };
  }

  const resolvedStateDir = stateDir || resolveStateDir();
  const binDir = getVideoBinDir(resolvedStateDir);
  const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binPath = path.join(binDir, binName);
  const metaPath = path.join(binDir, "ffmpeg-meta.json");

  if (fs.existsSync(binPath)) {
    const meta = readJsonSafe(metaPath);
    return {
      ok: true,
      version: meta?.version || null,
      source: "managed",
      binPath,
      message: `FFmpeg ${meta?.version || "unknown"} is installed (managed).`,
      fixCommand: null,
    };
  }

  if (!skipSystemCheck) {
    const systemPath = findInPath("ffmpeg");
    if (systemPath) {
      return {
        ok: true,
        version: null,
        source: "system",
        binPath: systemPath,
        message: `FFmpeg found in system PATH (${systemPath}).`,
        fixCommand: null,
      };
    }
  }

  return {
    ok: false,
    version: null,
    source: "missing",
    binPath: null,
    message: "FFmpeg is not installed.",
    fixCommand: "lupin setup --with-video",
  };
}

// ---------------------------------------------------------------------------
// Download exports
// ---------------------------------------------------------------------------

export async function downloadYtDlp(stateDir) {
  // Short-circuit if already installed and not stale
  const existing = getYtDlpStatus({ stateDir });
  if (existing.ok && existing.source === "managed" && !existing.stale) {
    console.error(`yt-dlp ${existing.version} is already installed and up to date.`);
    return { version: existing.version, binPath: existing.binPath };
  }

  const binDir = getVideoBinDir(stateDir);
  fs.mkdirSync(binDir, { recursive: true });

  const assetName = getYtDlpAssetName(process.platform, process.arch);
  const release = await fetchLatestYtDlpRelease();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`yt-dlp release ${release.tag} has no asset named ${assetName}`);
  }

  const binName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const binPath = path.join(binDir, binName);
  const metaPath = path.join(binDir, "yt-dlp-meta.json");

  console.error(`Downloading yt-dlp ${release.tag} (${assetName})...`);
  await downloadFile(asset.browser_download_url, binPath);

  if (process.platform !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }

  const { stdout } = await runSubprocess(binPath, ["--version"]);
  const version = stdout.trim();

  fs.writeFileSync(metaPath, JSON.stringify({ version, installedAt: new Date().toISOString() }));
  console.error(`yt-dlp ${version} installed.`);
  return { version, binPath };
}

export async function downloadFfmpeg(stateDir) {
  // Short-circuit if already installed (managed or system)
  const existing = getFfmpegStatus({ stateDir });
  if (existing.ok) {
    console.error(`FFmpeg already available (${existing.source}: ${existing.binPath}), skipping download.`);
    return { version: existing.version, binPath: existing.binPath, source: existing.source };
  }

  const binDir = getVideoBinDir(stateDir);
  fs.mkdirSync(binDir, { recursive: true });

  const assetName = getFfmpegAssetName(process.platform, process.arch);
  const releaseUrl = "https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest";
  const res = await httpsGet(releaseUrl);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const release = JSON.parse(Buffer.concat(chunks).toString());
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`ffmpeg-static release ${release.tag_name} has no asset named ${assetName}`);
  }

  const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binPath = path.join(binDir, binName);
  const metaPath = path.join(binDir, "ffmpeg-meta.json");

  console.error(`Downloading FFmpeg (${assetName})...`);
  await downloadGzipFile(asset.browser_download_url, binPath);

  if (process.platform !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }

  const { stdout } = await runSubprocess(binPath, ["-version"]);
  const versionMatch = stdout.match(/ffmpeg version (\S+)/);
  const version = versionMatch ? versionMatch[1] : null;

  fs.writeFileSync(metaPath, JSON.stringify({ version }));
  console.error(`FFmpeg ${version || "unknown"} installed.`);
  return { version, binPath, source: "managed" };
}

export async function runVideoSetup(stateDir) {
  await downloadYtDlp(stateDir);
  await downloadFfmpeg(stateDir);
  return {
    ytdlp: getYtDlpStatus({ stateDir }),
    ffmpeg: getFfmpegStatus({ stateDir }),
  };
}

export async function ensureYtDlpFresh(stateDir) {
  const status = getYtDlpStatus({ stateDir });
  if (!status.ok || status.source !== "managed" || !status.stale) {
    return status;
  }

  console.error(`yt-dlp is ${status.staleDays ?? "unknown"} days old, updating...`);
  try {
    await runSubprocess(status.binPath, ["--update"]);
    const { stdout } = await runSubprocess(status.binPath, ["--version"]);
    const version = stdout.trim();
    const metaPath = path.join(getVideoBinDir(stateDir), "yt-dlp-meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({ version, installedAt: new Date().toISOString() }));
    console.error(`yt-dlp updated to ${version}.`);
  } catch (err) {
    console.error(`yt-dlp auto-update failed (${err.message}), proceeding with existing version.`);
  }

  return getYtDlpStatus({ stateDir });
}
