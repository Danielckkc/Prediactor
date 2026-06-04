import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveProvider } from "../../src/llm/provider.js";
import { addProvider } from "../../src/llm/config.js";

describe("resolveProvider", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-provider-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns remote provider for named config entry", () => {
    addProvider(tmpDir, "testprov", {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
    });
    const result = resolveProvider({ stateDir: tmpDir, llm: "testprov" });
    assert.equal(result.type, "remote");
    assert.equal(result.model, "test-model");
  });

  it("throws descriptive error when nothing is configured", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-empty-"));
    try {
      assert.throws(
        () => resolveProvider({ stateDir: emptyDir }),
        /No LLM configured/
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
