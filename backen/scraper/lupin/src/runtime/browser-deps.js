import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import playwright from "playwright";

import { getYtDlpStatus, getFfmpegStatus } from "./video-deps.js";
import { formatCoreUpdateReport } from "./update-check.js";

const require = createRequire(import.meta.url);

function pathExists(value) {
  return Boolean(value) && fs.existsSync(value);
}

function resolvePackageBin(packageName, preferredBin = null) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = require(packageJsonPath);
  const binEntry =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.[preferredBin || Object.keys(packageJson.bin || {})[0]];

  if (!binEntry) {
    throw new Error(`Could not resolve a runnable bin for ${packageName}`);
  }

  return path.resolve(path.dirname(packageJsonPath), binEntry);
}

function getCamoufoxInstallDir() {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "camoufox", "camoufox", "Cache");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "camoufox");
  }
  return path.join(os.homedir(), ".cache", "camoufox");
}

export function getCamoufoxStatus() {
  const installDir = getCamoufoxInstallDir();
  const versionPath = path.join(installDir, "version.json");

  if (!pathExists(versionPath)) {
    return {
      ok: false,
      installDir,
      version: null,
      source: "missing",
      message: "Camoufox browser bundle is not installed.",
      fixCommand: "lupin setup",
    };
  }

  try {
    const version = JSON.parse(fs.readFileSync(versionPath, "utf8")).version || null;
    return {
      ok: true,
      installDir,
      version,
      source: "cache",
      message: version ? `Camoufox ${version} is installed.` : "Camoufox is installed.",
      fixCommand: null,
    };
  } catch {
    return {
      ok: false,
      installDir,
      version: null,
      source: "corrupt",
      message: `Camoufox metadata could not be read from ${versionPath}.`,
      fixCommand: "lupin setup",
    };
  }
}

export function getPlaywrightChromiumStatus() {
  const executablePath = playwright.chromium.executablePath();
  const ok = pathExists(executablePath);

  return {
    ok,
    executablePath,
    source: ok ? "playwright" : "missing",
    message: ok
      ? `Playwright Chromium is installed at ${executablePath}.`
      : "Playwright Chromium is not installed.",
    fixCommand: ok ? null : "lupin setup",
  };
}

function getSystemChromeCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Chromium", "Application", "chrome.exe"),
      path.join(programFilesX86, "Chromium", "Application", "chrome.exe"),
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

export function findSystemChromeExecutable() {
  return getSystemChromeCandidates().find((candidate) => pathExists(candidate)) || null;
}

export function resolveFallbackExecutablePath(config = {}) {
  if (config.executablePath && pathExists(config.executablePath)) {
    return { path: config.executablePath, source: "configured" };
  }

  const playwrightChromium = getPlaywrightChromiumStatus();
  if (playwrightChromium.ok) {
    return { path: playwrightChromium.executablePath, source: "playwright" };
  }

  const systemChromePath = findSystemChromeExecutable();
  if (systemChromePath) {
    return { path: systemChromePath, source: "system-chrome" };
  }

  return { path: null, source: null };
}

export function getFallbackBrowserStatus(config = {}) {
  if (config.fallbackProvider === "cdp") {
    const ok = Boolean(config.cdpUrl);
    return {
      ok,
      verified: ok,
      provider: "cdp",
      executablePath: null,
      source: ok ? "cdp" : "missing",
      message: ok
        ? `CDP fallback is configured for ${config.cdpUrl}.`
        : "CDP fallback is selected but LUPIN_CDP_URL is not configured.",
      fixCommand: ok ? null : "Set LUPIN_CDP_URL or run lupin setup and use the default patchright fallback.",
    };
  }

  const resolved = resolveFallbackExecutablePath(config);
  if (resolved.path) {
    return {
      ok: true,
      verified: true,
      provider: "patchright",
      executablePath: resolved.path,
      source: resolved.source,
      message: `Fallback browser is available via ${resolved.source} (${resolved.path}).`,
      fixCommand: null,
    };
  }

  if (config.chromeChannel) {
    return {
      ok: true,
      verified: false,
      provider: "patchright",
      executablePath: null,
      source: "channel",
      message: `Fallback browser will be attempted via browser channel "${config.chromeChannel}", but no concrete executable path was verified.`,
      fixCommand: "lupin setup",
    };
  }

  return {
    ok: false,
    verified: false,
    provider: "patchright",
    executablePath: null,
    source: "missing",
    message: "No fallback browser executable was found.",
    fixCommand: "lupin setup",
  };
}

export function getDoctorReport({ config = {}, stateDir } = {}) {
  const camoufox = getCamoufoxStatus();
  const fallback = getFallbackBrowserStatus(config);
  const report = {
    ok: camoufox.ok && fallback.ok && fallback.verified !== false,
    snapshotDate: new Date().toISOString().slice(0, 10),
    stateDir,
    http: {
      ok: true,
      message: "HTTP stage is always available when Node networking works.",
    },
    camoufox,
    fallback,
    warnings: [],
  };

  if (!camoufox.ok) {
    report.warnings.push("Camoufox is missing, so browser-backed search and Camoufox fetch paths will fail.");
  }
  if (!fallback.ok) {
    report.warnings.push("Fallback browser is missing, so hostile-page recovery and browser MCP sessions will fail.");
  } else if (fallback.verified === false) {
    report.warnings.push("Fallback browser is only configured via a browser channel, so fresh installs may still fail until you run lupin setup.");
  }

  report.ytdlp = getYtDlpStatus({ stateDir });
  report.ffmpeg = getFfmpegStatus({ stateDir });

  return report;
}

export function evaluateBrowserRequirements(report, requirements = {}) {
  const missing = [];
  const warnings = [];

  if (requirements.camoufox && !report.camoufox.ok) {
    missing.push("camoufox");
  }

  if (requirements.fallback && !report.fallback.ok) {
    missing.push("fallback");
  } else if (requirements.fallback && report.fallback.verified === false) {
    warnings.push("Fallback browser has only a provisional channel-based configuration.");
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  };
}

export function formatDoctorReport(report) {
  const lines = [
    `lupin doctor (${report.snapshotDate})`,
    `Full browser-backed readiness: ${report.ok ? "OK" : "INCOMPLETE"}`,
  ];

  if (report.stateDir) {
    lines.push(`State dir: ${report.stateDir}`);
  }

  if (report.lupin) {
    lines.push(formatCoreUpdateReport(report.lupin));
  }

  lines.push(`HTTP: OK - ${report.http.message}`);
  lines.push(`Camoufox: ${report.camoufox.ok ? "OK" : "MISSING"} - ${report.camoufox.message}`);
  if (report.camoufox.installDir) {
    lines.push(`Camoufox dir: ${report.camoufox.installDir}`);
  }
  lines.push(
    `Fallback: ${report.fallback.ok ? (report.fallback.verified === false ? "PARTIAL" : "OK") : "MISSING"} - ${report.fallback.message}`
  );

  // Video deps (optional)
  if (report.ytdlp) {
    const ytdlpLabel = report.ytdlp.ok
      ? report.ytdlp.stale
        ? "STALE"
        : "OK"
      : "NOT INSTALLED";
    lines.push(`yt-dlp: ${ytdlpLabel} - ${report.ytdlp.message}`);
  }
  if (report.ffmpeg) {
    const ffmpegLabel = report.ffmpeg.ok ? "OK" : "NOT INSTALLED";
    lines.push(`FFmpeg: ${ffmpegLabel} - ${report.ffmpeg.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (!report.ok) {
    lines.push("Suggested fix: lupin setup");
  }

  return lines.join("\n");
}

function runCommand(command, args, { inheritStdio = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: inheritStdio ? "inherit" : "pipe",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

export async function runSetup() {
  const camoufoxBin = resolvePackageBin("camoufox-js");
  const playwrightBin = resolvePackageBin("playwright", "playwright");

  await runCommand(process.execPath, [camoufoxBin, "fetch"]);
  await runCommand(process.execPath, [playwrightBin, "install", "chromium"]);

  return getDoctorReport({});
}

export function formatPreflightMessage(report, context, requirements = {}) {
  const lines = [`${context} requires browser assets that are not fully installed.`];
  const readiness = evaluateBrowserRequirements(report, requirements);

  if (requirements.camoufox && !report.camoufox.ok) {
    lines.push(`Camoufox: ${report.camoufox.message}`);
  }
  if (requirements.fallback && !report.fallback.ok) {
    lines.push(`Fallback: ${report.fallback.message}`);
  }
  for (const warning of readiness.warnings) {
    lines.push(warning);
  }

  lines.push("Run `lupin setup` to install the missing browsers.");
  lines.push("Run `lupin doctor` to inspect the current runtime.");

  return lines.join("\n");
}
