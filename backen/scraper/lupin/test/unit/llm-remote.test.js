import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runRemote } from "../../src/llm/remote.js";

let capturedBody = null;
const originalFetch = globalThis.fetch;

function mockFetch(response) {
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => response,
    };
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  capturedBody = null;
}

describe("runRemote multimodal", () => {
  afterEach(restoreFetch);

  it("sends plain string user message when no media", async () => {
    mockFetch({ choices: [{ message: { content: "result" } }] });
    await runRemote("page text", {
      prompt: "describe",
      baseUrl: "http://localhost",
      model: "test",
    });
    const userMsg = capturedBody.messages[1];
    assert.equal(typeof userMsg.content, "string");
  });

  it("sends content parts array when media is provided", async () => {
    mockFetch({ choices: [{ message: { content: "result" } }] });
    const media = [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ];
    await runRemote("page text", {
      prompt: "describe",
      media,
      baseUrl: "http://localhost",
      model: "test",
    });
    const userMsg = capturedBody.messages[1];
    assert.ok(Array.isArray(userMsg.content));
    assert.equal(userMsg.content[0].type, "text");
    assert.equal(userMsg.content[1].type, "image_url");
  });

  it("includes hasMedia in system prompt when media present", async () => {
    mockFetch({ choices: [{ message: { content: "result" } }] });
    const media = [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ];
    await runRemote("page text", {
      prompt: "describe",
      media,
      baseUrl: "http://localhost",
      model: "test",
    });
    const sysMsg = capturedBody.messages[0].content;
    assert.ok(sysMsg.includes("media"));
  });
});
