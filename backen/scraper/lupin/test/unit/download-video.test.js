import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildYtDlpArgs, parseYtDlpOutput } from "../../src/providers/video/download.js";

describe("buildYtDlpArgs", () => {
  it("builds default args for a URL", () => {
    const args = buildYtDlpArgs("https://youtube.com/watch?v=abc", {
      ffmpegDir: "/tmp/bin",
    });
    assert.ok(args.includes("https://youtube.com/watch?v=abc"));
    assert.ok(args.includes("--print-json"));
    assert.ok(args.includes("--no-playlist"));
    assert.ok(args.includes("--merge-output-format"));
    assert.ok(args.includes("mp4"));
    assert.ok(args.includes("--ffmpeg-location"));
    assert.ok(args.includes("/tmp/bin"));
  });

  it("adds audio-only flags", () => {
    const args = buildYtDlpArgs("https://youtube.com/watch?v=abc", {
      ffmpegDir: "/tmp/bin",
      audioOnly: true,
    });
    assert.ok(args.includes("-x"));
    assert.ok(args.includes("--audio-format"));
    assert.ok(args.includes("mp3"));
    assert.ok(!args.includes("--merge-output-format"));
  });

  it("adds subtitle flags", () => {
    const args = buildYtDlpArgs("https://youtube.com/watch?v=abc", {
      ffmpegDir: "/tmp/bin",
      subtitles: true,
    });
    assert.ok(args.includes("--write-subs"));
    assert.ok(args.includes("--sub-langs"));
    assert.ok(args.includes("all"));
  });

  it("uses custom output dir", () => {
    const args = buildYtDlpArgs("https://youtube.com/watch?v=abc", {
      ffmpegDir: "/tmp/bin",
      outputDir: "/my/downloads",
    });
    const oIndex = args.indexOf("-o");
    assert.ok(oIndex !== -1);
    assert.ok(args[oIndex + 1].startsWith("/my/downloads/"));
  });
});

describe("parseYtDlpOutput", () => {
  it("parses yt-dlp JSON output into structured result", () => {
    const ytdlpJson = {
      title: "Test Video",
      uploader: "Test Channel",
      uploader_url: "https://youtube.com/@test",
      upload_date: "20260315",
      webpage_url: "https://youtube.com/watch?v=abc123",
      extractor_key: "Youtube",
      id: "abc123",
      _filename: "/downloads/Test Video [abc123].mp4",
      filesize: 12345678,
      ext: "mp4",
      duration: 120,
      thumbnail: "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
      requested_subtitles: {
        en: { filepath: "/downloads/Test Video [abc123].en.vtt" },
        fr: { filepath: "/downloads/Test Video [abc123].fr.vtt" },
      },
    };

    const result = parseYtDlpOutput(ytdlpJson);
    assert.equal(result.entityType, "download");
    assert.equal(result.title, "Test Video");
    assert.equal(result.author.name, "Test Channel");
    assert.equal(result.author.url, "https://youtube.com/@test");
    assert.equal(result.publishedAt, "2026-03-15");
    assert.equal(result.platform.site, "youtube");
    assert.equal(result.platform.videoId, "abc123");
    assert.equal(result.file.path, "/downloads/Test Video [abc123].mp4");
    assert.equal(result.file.sizeBytes, 12345678);
    assert.equal(result.file.format, "mp4");
    assert.equal(result.file.durationSeconds, 120);
    assert.equal(result.thumbnail, "https://i.ytimg.com/vi/abc123/maxresdefault.jpg");
    assert.equal(result.subtitles.length, 2);
    assert.equal(result.subtitles[0].language, "en");
  });

  it("handles missing optional fields", () => {
    const ytdlpJson = {
      title: "Minimal",
      id: "xyz",
      _filename: "/tmp/Minimal [xyz].mp4",
      ext: "mp4",
      extractor_key: "Generic",
    };

    const result = parseYtDlpOutput(ytdlpJson);
    assert.equal(result.title, "Minimal");
    assert.equal(result.author.name, null);
    assert.equal(result.publishedAt, null);
    assert.equal(result.file.sizeBytes, null);
    assert.equal(result.file.durationSeconds, null);
    assert.equal(result.subtitles, null);
    assert.equal(result.thumbnail, null);
  });
});
