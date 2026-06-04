import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildUserMessage } from "../../src/llm/prompts.js";

describe("buildSystemPrompt", () => {
  it("returns extract prompt when only prompt is given", () => {
    const sys = buildSystemPrompt({ prompt: "summarize" });
    assert.ok(sys.includes("precise data extraction"));
    assert.ok(!sys.includes("JSON object matching"));
  });

  it("returns schema prompt when only schema is given", () => {
    const sys = buildSystemPrompt({ schema: { type: "object" } });
    assert.ok(sys.includes("structured data extraction"));
    assert.ok(sys.includes("JSON object matching the provided schema"));
  });

  it("returns combined prompt when both are given", () => {
    const sys = buildSystemPrompt({ prompt: "only CEOs", schema: { type: "object" } });
    assert.ok(sys.includes("structured data extraction"));
    assert.ok(sys.includes("specific instruction"));
  });
});

describe("buildUserMessage", () => {
  const pageContent = "Hello World page content";

  it("appends instruction for extract-only mode", () => {
    const msg = buildUserMessage(pageContent, { prompt: "summarize this" });
    assert.ok(msg.includes(pageContent));
    assert.ok(msg.includes("---"));
    assert.ok(msg.includes("Instruction: summarize this"));
    assert.ok(!msg.includes("JSON schema"));
  });

  it("appends schema for schema-only mode", () => {
    const schema = { type: "object", properties: { title: { type: "string" } } };
    const msg = buildUserMessage(pageContent, { schema });
    assert.ok(msg.includes(pageContent));
    assert.ok(msg.includes("Extract data matching this JSON schema:"));
    assert.ok(msg.includes('"type": "object"'));
  });

  it("appends both instruction and schema for combined mode", () => {
    const schema = { type: "object" };
    const msg = buildUserMessage(pageContent, { prompt: "only founders", schema });
    assert.ok(msg.includes("Instruction: only founders"));
    assert.ok(msg.includes("Extract data matching this JSON schema:"));
  });

  it("does not include schema section when no schema provided", () => {
    const msg = buildUserMessage(pageContent, { prompt: "test" });
    assert.ok(!msg.includes("Extract data matching"));
  });

  it("does not include instruction when no prompt provided", () => {
    const msg = buildUserMessage(pageContent, { schema: { type: "object" } });
    assert.ok(!msg.includes("Instruction:"));
  });
});

describe("buildUserMessage with media", () => {
  const pageContent = "Instagram post about fashion";

  it("returns a string when no media is provided", () => {
    const msg = buildUserMessage(pageContent, { prompt: "describe" });
    assert.equal(typeof msg, "string");
  });

  it("returns a string when media is an empty array", () => {
    const msg = buildUserMessage(pageContent, { prompt: "describe", media: [] });
    assert.equal(typeof msg, "string");
  });

  it("returns an array of content parts when media is present", () => {
    const media = [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
    ];
    const msg = buildUserMessage(pageContent, { prompt: "describe", media });
    assert.ok(Array.isArray(msg));
    assert.equal(msg[0].type, "text");
    assert.ok(msg[0].text.includes(pageContent));
    assert.ok(msg[0].text.includes("Instruction: describe"));
    assert.equal(msg[1].type, "image_url");
    assert.equal(msg[1].image_url.url, "data:image/jpeg;base64,abc123");
  });

  it("includes video_url content parts", () => {
    const media = [
      { type: "video_url", video_url: { url: "https://youtube.com/watch?v=abc" } },
    ];
    const msg = buildUserMessage(pageContent, { prompt: "summarize", media });
    assert.ok(Array.isArray(msg));
    assert.equal(msg[1].type, "video_url");
  });

  it("includes multiple media items", () => {
    const media = [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,img1" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,img2" } },
    ];
    const msg = buildUserMessage(pageContent, { prompt: "describe", media });
    assert.equal(msg.length, 3); // text + 2 images
  });
});

describe("buildSystemPrompt with media", () => {
  it("mentions media in system prompt when hasMedia is true", () => {
    const sys = buildSystemPrompt({ prompt: "describe", hasMedia: true });
    assert.ok(sys.includes("media"));
  });

  it("does not mention media when hasMedia is false", () => {
    const sys = buildSystemPrompt({ prompt: "describe", hasMedia: false });
    assert.ok(!sys.includes("media"));
  });

  it("does not mention media when hasMedia is omitted", () => {
    const sys = buildSystemPrompt({ prompt: "describe" });
    assert.ok(!sys.includes("media"));
  });

  it("mentions media in schema-only system prompt when hasMedia is true", () => {
    const sys = buildSystemPrompt({ schema: { type: "object" }, hasMedia: true });
    assert.ok(sys.includes("media"));
  });

  it("mentions media in combined system prompt when hasMedia is true", () => {
    const sys = buildSystemPrompt({ prompt: "x", schema: { type: "object" }, hasMedia: true });
    assert.ok(sys.includes("media"));
  });
});
