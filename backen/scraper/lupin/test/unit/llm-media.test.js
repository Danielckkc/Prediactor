import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveMedia, isGeminiModel, isYouTubeUrl, isMultimodalModel } from "../../src/llm/media.js";

describe("isGeminiModel", () => {
  it("returns true for gemini model names", () => {
    assert.ok(isGeminiModel("google/gemini-2.5-flash"));
    assert.ok(isGeminiModel("google/gemini-2.5-flash-lite"));
    assert.ok(isGeminiModel("Gemini-Pro"));
  });

  it("returns false for non-gemini models", () => {
    assert.ok(!isGeminiModel("qwen/qwen3.5-9b"));
    assert.ok(!isGeminiModel("openai/gpt-4o"));
    assert.ok(!isGeminiModel(""));
  });
});

describe("isYouTubeUrl", () => {
  it("matches youtube.com watch URLs", () => {
    assert.ok(isYouTubeUrl("https://www.youtube.com/watch?v=abc123"));
    assert.ok(isYouTubeUrl("https://youtube.com/watch?v=abc123"));
  });

  it("matches youtu.be short URLs", () => {
    assert.ok(isYouTubeUrl("https://youtu.be/abc123"));
  });

  it("rejects non-youtube URLs", () => {
    assert.ok(!isYouTubeUrl("https://www.tiktok.com/@user/video/123"));
    assert.ok(!isYouTubeUrl("https://instagram.com/p/abc"));
  });
});

describe("isMultimodalModel", () => {
  it("returns true for Gemini models", () => {
    assert.ok(isMultimodalModel("google/gemini-2.5-flash"));
    assert.ok(isMultimodalModel("google/gemini-2.5-flash-lite"));
  });

  it("returns true for GPT-4o", () => {
    assert.ok(isMultimodalModel("openai/gpt-4o"));
    assert.ok(isMultimodalModel("openai/gpt-4o-mini"));
  });

  it("returns true for Claude 3+ models", () => {
    assert.ok(isMultimodalModel("anthropic/claude-sonnet-4"));
    assert.ok(isMultimodalModel("anthropic/claude-3.5-sonnet"));
  });

  it("returns true for Qwen 3.5 models", () => {
    assert.ok(isMultimodalModel("qwen/qwen3.5-9b"));
  });

  it("returns false for text-only models", () => {
    assert.ok(!isMultimodalModel("meta-llama/llama-3-8b"));
    assert.ok(!isMultimodalModel("arcee-ai/trinity-mini"));
    assert.ok(!isMultimodalModel("mistral/mixtral-8x7b"));
    assert.ok(!isMultimodalModel(""));
  });

  it("returns false for null/undefined", () => {
    assert.ok(!isMultimodalModel(null));
    assert.ok(!isMultimodalModel(undefined));
  });
});

describe("resolveMedia", () => {
  let stderrOutput;
  let originalStderrWrite;

  beforeEach(() => {
    originalStderrWrite = process.stderr.write;
    stderrOutput = "";
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it("returns empty array for empty media", async () => {
    const result = await resolveMedia([], { model: "test", stateDir: "/tmp" });
    assert.deepEqual(result, []);
  });

  it("returns empty array for undefined media", async () => {
    const result = await resolveMedia(undefined, { model: "test", stateDir: "/tmp" });
    assert.deepEqual(result, []);
  });

  it("resolves image by downloading and base64 encoding", async () => {
    const originalFetch = globalThis.fetch;
    const fakeImageBytes = Buffer.from("fake-image-data");
    globalThis.fetch = async (url) => ({
      ok: true,
      headers: { get: (h) => h === "content-type" ? "image/jpeg" : null },
      arrayBuffer: async () => fakeImageBytes.buffer,
    });

    try {
      const media = [{ type: "image", url: "https://example.com/photo.jpg" }];
      const result = await resolveMedia(media, { model: "test", stateDir: "/tmp" });
      assert.equal(result.length, 1);
      assert.equal(result[0].type, "image_url");
      assert.ok(result[0].image_url.url.startsWith("data:image/jpeg;base64,"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips image on download failure and warns", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });

    try {
      const media = [{ type: "image", url: "https://example.com/missing.jpg" }];
      const result = await resolveMedia(media, { model: "test", stateDir: "/tmp" });
      assert.equal(result.length, 0);
      assert.ok(stderrOutput.includes("Warning"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes YouTube URL directly for Gemini models", async () => {
    const media = [{ type: "video", url: "https://cdn.tiktok.com/video.mp4" }];
    const sourceUrl = "https://www.youtube.com/watch?v=abc123";
    const result = await resolveMedia(media, {
      model: "google/gemini-2.5-flash",
      stateDir: "/tmp",
      sourceUrl,
      entityType: "video",
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "video_url");
    assert.equal(result[0].video_url.url, sourceUrl);
  });

  it("does NOT download video for non-Gemini when media has only thumbnail (entityType=video)", async () => {
    // YouTube returns entityType "video" but media[] only has a thumbnail image.
    // Non-Gemini models should NOT trigger a yt-dlp download for this case.
    const media = [{ type: "image", url: "https://i.ytimg.com/thumb.jpg" }];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => Buffer.from("thumb").buffer,
    });

    try {
      const result = await resolveMedia(media, {
        model: "qwen/qwen3.5-9b",
        stateDir: "/tmp",
        sourceUrl: "https://www.youtube.com/watch?v=abc123",
        entityType: "video",
      });
      // Should only have the thumbnail image, no video_url
      assert.equal(result.length, 1);
      assert.equal(result[0].type, "image_url");
      const videoItem = result.find((r) => r.type === "video_url");
      assert.ok(!videoItem, "should NOT attempt video download when media has no video item");
      assert.ok(!stderrOutput.includes("yt-dlp"), "should not mention yt-dlp");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes YouTube URL for entityType=video even without video in media array", async () => {
    const media = [{ type: "image", url: "https://i.ytimg.com/thumb.jpg" }];
    const sourceUrl = "https://www.youtube.com/watch?v=abc123";

    const originalFetch = globalThis.fetch;
    const fakeImageBytes = Buffer.from("fake-thumb");
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => fakeImageBytes.buffer,
    });

    try {
      const result = await resolveMedia(media, {
        model: "google/gemini-2.5-flash",
        stateDir: "/tmp",
        sourceUrl,
        entityType: "video",
      });
      const videoItem = result.find((r) => r.type === "video_url");
      assert.ok(videoItem);
      assert.equal(videoItem.video_url.url, sourceUrl);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
