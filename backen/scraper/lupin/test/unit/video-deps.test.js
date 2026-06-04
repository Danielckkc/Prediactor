import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getYtDlpStatus, getFfmpegStatus, getVideoBinDir, getYtDlpAssetName, getFfmpegAssetName } from "../../src/runtime/video-deps.js";

describe("getYtDlpStatus", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-deps-test-"));
  const binDir = path.join(tmpDir, "bin");

  before(() => fs.mkdirSync(binDir, { recursive: true }));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns missing when no binary exists", () => {
    const status = getYtDlpStatus({ stateDir: tmpDir });
    assert.equal(status.ok, false);
    assert.equal(status.source, "missing");
    assert.ok(status.message.includes("not installed"));
    assert.equal(status.fixCommand, "lupin setup --with-video");
  });

  it("returns ok when binary and meta exist", () => {
    const binName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    fs.writeFileSync(path.join(binDir, binName), "fake-binary");
    fs.writeFileSync(
      path.join(binDir, "yt-dlp-meta.json"),
      JSON.stringify({ version: "2026.03.17", installedAt: new Date().toISOString() })
    );

    const status = getYtDlpStatus({ stateDir: tmpDir });
    assert.equal(status.ok, true);
    assert.equal(status.source, "managed");
    assert.equal(status.version, "2026.03.17");
    assert.equal(status.stale, false);
    assert.equal(status.fixCommand, null);
  });

  it("reports stale when installedAt is old", () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(binDir, "yt-dlp-meta.json"),
      JSON.stringify({ version: "2026.02.01", installedAt: old })
    );

    const status = getYtDlpStatus({ stateDir: tmpDir });
    assert.equal(status.ok, true);
    assert.equal(status.stale, true);
    assert.ok(status.staleDays >= 29);
  });

  it("respects env override", () => {
    const origEnv = process.env.LUPIN_YTDLP_PATH;
    process.env.LUPIN_YTDLP_PATH = "/usr/local/bin/yt-dlp";
    try {
      const status = getYtDlpStatus({ stateDir: tmpDir });
      assert.equal(status.source, "env");
      assert.equal(status.binPath, "/usr/local/bin/yt-dlp");
    } finally {
      if (origEnv === undefined) delete process.env.LUPIN_YTDLP_PATH;
      else process.env.LUPIN_YTDLP_PATH = origEnv;
    }
  });
});

describe("getFfmpegStatus", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-deps-test-"));
  const binDir = path.join(tmpDir, "bin");

  before(() => fs.mkdirSync(binDir, { recursive: true }));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns missing when no binary and not in PATH", () => {
    const status = getFfmpegStatus({ stateDir: tmpDir, skipSystemCheck: true });
    assert.equal(status.ok, false);
    assert.equal(status.source, "missing");
    assert.ok(status.message.includes("not installed"));
  });

  it("returns ok when managed binary exists", () => {
    const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    fs.writeFileSync(path.join(binDir, binName), "fake-binary");
    fs.writeFileSync(
      path.join(binDir, "ffmpeg-meta.json"),
      JSON.stringify({ version: "6.1.1" })
    );

    const status = getFfmpegStatus({ stateDir: tmpDir });
    assert.equal(status.ok, true);
    assert.equal(status.source, "managed");
    assert.equal(status.version, "6.1.1");
  });

  it("respects env override", () => {
    const origEnv = process.env.LUPIN_FFMPEG_PATH;
    process.env.LUPIN_FFMPEG_PATH = "/usr/local/bin/ffmpeg";
    try {
      const status = getFfmpegStatus({ stateDir: tmpDir });
      assert.equal(status.source, "env");
      assert.equal(status.binPath, "/usr/local/bin/ffmpeg");
    } finally {
      if (origEnv === undefined) delete process.env.LUPIN_FFMPEG_PATH;
      else process.env.LUPIN_FFMPEG_PATH = origEnv;
    }
  });
});

describe("platform asset mapping", () => {
  it("maps darwin arm64 to yt-dlp_macos", () => {
    assert.equal(getYtDlpAssetName("darwin", "arm64"), "yt-dlp_macos");
  });
  it("maps darwin x64 to yt-dlp_macos", () => {
    assert.equal(getYtDlpAssetName("darwin", "x64"), "yt-dlp_macos");
  });
  it("maps linux x64 to yt-dlp_linux", () => {
    assert.equal(getYtDlpAssetName("linux", "x64"), "yt-dlp_linux");
  });
  it("maps linux arm64 to yt-dlp_linux_aarch64", () => {
    assert.equal(getYtDlpAssetName("linux", "arm64"), "yt-dlp_linux_aarch64");
  });
  it("maps win32 x64 to yt-dlp.exe", () => {
    assert.equal(getYtDlpAssetName("win32", "x64"), "yt-dlp.exe");
  });
  it("throws for unsupported platform", () => {
    assert.throws(() => getYtDlpAssetName("freebsd", "x64"), /Unsupported platform/);
  });

  it("maps darwin arm64 to ffmpeg-darwin-arm64.gz", () => {
    assert.equal(getFfmpegAssetName("darwin", "arm64"), "ffmpeg-darwin-arm64.gz");
  });
  it("maps linux x64 to ffmpeg-linux-x64.gz", () => {
    assert.equal(getFfmpegAssetName("linux", "x64"), "ffmpeg-linux-x64.gz");
  });
  it("maps win32 x64 to ffmpeg-win32-x64.gz", () => {
    assert.equal(getFfmpegAssetName("win32", "x64"), "ffmpeg-win32-x64.gz");
  });
});
