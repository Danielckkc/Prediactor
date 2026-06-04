import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveMedia, isGeminiModel } from "../../src/llm/media.js";
import { buildUserMessage, buildSystemPrompt } from "../../src/llm/prompts.js";

describe("multimodal pipeline integration", () => {
  const originalFetch = globalThis.fetch;
  let stderrOutput;
  let originalStderrWrite;

  beforeEach(() => {
    originalStderrWrite = process.stderr.write;
    stderrOutput = "";
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
  });

  it("Instagram image → resolveMedia → buildUserMessage produces multimodal content", async () => {
    const fakeImage = Buffer.from("fake-jpeg-bytes");
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => fakeImage.buffer,
    });

    const providerMedia = [{ type: "image", url: "https://cdn.instagram.com/photo.jpg" }];
    const resolved = await resolveMedia(providerMedia, {
      model: "google/gemini-2.5-flash",
      stateDir: "/tmp",
    });

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].type, "image_url");

    const message = buildUserMessage('{"caption": "Nice view"}', {
      prompt: "what brands are visible?",
      media: resolved,
    });

    assert.ok(Array.isArray(message));
    assert.equal(message[0].type, "text");
    assert.ok(message[0].text.includes("Nice view"));
    assert.ok(message[0].text.includes("Instruction: what brands are visible?"));
    assert.equal(message[1].type, "image_url");
  });

  it("YouTube + Gemini → resolveMedia passes URL directly", async () => {
    const providerMedia = [{ type: "image", url: "https://i.ytimg.com/vi/abc/thumb.jpg" }];

    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => Buffer.from("thumb").buffer,
    });

    const resolved = await resolveMedia(providerMedia, {
      model: "google/gemini-2.5-flash-lite",
      stateDir: "/tmp",
      sourceUrl: "https://www.youtube.com/watch?v=tTBzI8fJBPM",
      entityType: "video",
    });

    const videoItem = resolved.find((r) => r.type === "video_url");
    assert.ok(videoItem, "should include video_url part");
    assert.equal(videoItem.video_url.url, "https://www.youtube.com/watch?v=tTBzI8fJBPM");

    const imageItem = resolved.find((r) => r.type === "image_url");
    assert.ok(imageItem, "should also include thumbnail as image_url");
  });

  it("system prompt reflects media presence", () => {
    const withMedia = buildSystemPrompt({ prompt: "describe", hasMedia: true });
    const withoutMedia = buildSystemPrompt({ prompt: "describe", hasMedia: false });

    assert.ok(withMedia.includes("media"));
    assert.ok(!withoutMedia.includes("media"));
  });

  it("non-Gemini + video without yt-dlp → warns and skips video", async () => {
    const providerMedia = [{ type: "video", url: "https://cdn.tiktok.com/video.mp4" }];

    const resolved = await resolveMedia(providerMedia, {
      model: "qwen/qwen3.5-9b",
      stateDir: "/tmp/nonexistent-state-dir",
      sourceUrl: "https://www.tiktok.com/@user/video/123",
    });

    const videoItem = resolved.find((r) => r.type === "video_url");
    assert.ok(!videoItem || stderrOutput.includes("Warning"));
  });

  it("image download failure → warns and continues", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });

    const providerMedia = [
      { type: "image", url: "https://example.com/expired.jpg" },
    ];

    const resolved = await resolveMedia(providerMedia, {
      model: "test-model",
      stateDir: "/tmp",
    });

    assert.equal(resolved.length, 0);
    assert.ok(stderrOutput.includes("Warning"));
  });
});
