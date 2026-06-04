import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmConfigError } from "../../src/llm/errors.js";
import { interpolateEnvVars } from "../../src/llm/config.js";

// ---------------------------------------------------------------------------
// Fix #2: interpolateEnvVars throws LlmConfigError, not plain Error
// ---------------------------------------------------------------------------

describe("interpolateEnvVars throws LlmConfigError for missing env vars", () => {
  it("throws LlmConfigError (not plain Error) for missing env var", () => {
    try {
      interpolateEnvVars("${__REVIEW_FIX_MISSING_VAR}");
      assert.fail("Expected LlmConfigError");
    } catch (error) {
      assert.ok(
        error instanceof LlmConfigError,
        `Expected LlmConfigError but got ${error.constructor.name}: ${error.message}`
      );
      assert.match(error.message, /__REVIEW_FIX_MISSING_VAR/);
      assert.match(error.message, /not set/);
    }
  });

  it("includes actionable export hint in error message", () => {
    try {
      interpolateEnvVars("${MY_API_KEY}");
      assert.fail("Expected LlmConfigError");
    } catch (error) {
      assert.match(error.message, /export MY_API_KEY=/);
    }
  });

  it("does not throw for present env vars", () => {
    process.env.__REVIEW_FIX_PRESENT = "value";
    try {
      const result = interpolateEnvVars("${__REVIEW_FIX_PRESENT}");
      assert.equal(result, "value");
    } finally {
      delete process.env.__REVIEW_FIX_PRESENT;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #1: LLM failure → content: null (fetch_page path)
// ---------------------------------------------------------------------------

describe("fetchPage sets content: null on LLM runtime failure", () => {
  it("sets content to null and llm.error when LLM fails (non-config error)", async () => {
    // We test the catch path in fetch.js by importing fetchPage with a mock scraper
    // and an LLM provider that will fail at runtime (not config error)
    const { fetchPage } = await import("../../src/providers/web/fetch.js");

    // Minimal mock scraper that returns a valid scrape result
    const mockScraper = {
      async scrape() {
        return {
          ok: true,
          url: "https://example.com",
          title: "Example",
          text: "Example Domain",
          rawHtml: "<html><head><title>Example</title></head><body><p>Example Domain</p></body></html>",
          engine: "http",
          confidence: "high",
          status: 200,
          warnings: [],
          blocked: false,
        };
      },
    };

    // Use a non-existent LLM provider name that will resolve but fail at runtime
    // We need stateDir pointing to a temp dir with a config that has a provider
    // pointing to a dead endpoint
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-null-test-"));

    try {
      // Write a config with a remote provider pointing to a dead endpoint
      const config = {
        providers: {
          dead: {
            baseUrl: "http://127.0.0.1:1",
            model: "test",
          },
        },
        local: { enabled: false },
        default: "dead",
      };
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "llm.json"), JSON.stringify(config));

      const result = await fetchPage(mockScraper, "https://example.com", {
        extract: "summarize",
        llm: "dead",
        stateDir: tmpDir,
        format: "json",
      });

      // content must be null, not the raw scraped page
      assert.equal(result.content, null, "content should be null on LLM failure");
      assert.ok(result.llm, "llm metadata should be present");
      assert.ok(result.llm.error, "llm.error should contain error message");
      assert.equal(result.llm.model, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #1: LLM failure → content: null (platform provider path via callFetchTool)
// The platform LLM post-processing in callFetchTool catches non-LlmConfigError
// and must set result.content = null. We test this by verifying the catch block
// directly: import runLlm and confirm that when it throws a non-config error,
// the callFetchTool catch path sets content to null.
// ---------------------------------------------------------------------------

describe("callFetchTool LLM error handling sets content: null", () => {
  it("verifies the catch block sets content: null (not original content)", async () => {
    // Read the source to verify the fix is present — the catch block must
    // contain `result.content = null` not leave content untouched
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve("src/mcp/tools/fetch-tools.js"),
      "utf8"
    );

    // Find the LLM catch block for platform providers
    const catchMatch = source.match(/catch\s*\(error\)\s*\{[^}]*LlmConfigError[^}]*result\.content\s*=\s*null/s);
    assert.ok(
      catchMatch,
      "catch block in callFetchTool must set result.content = null on non-config LLM error"
    );
  });
});

// ---------------------------------------------------------------------------
// Fix #2: LlmConfigError propagates (not caught by fallback)
// ---------------------------------------------------------------------------

describe("LlmConfigError propagates through fetch without being swallowed", () => {
  it("throws LlmConfigError for missing env var in provider config", async () => {
    const { fetchPage } = await import("../../src/providers/web/fetch.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-config-err-"));

    try {
      const config = {
        providers: {
          broken: {
            baseUrl: "https://api.example.com/v1",
            apiKey: "${__REVIEW_FIX_NONEXISTENT_KEY}",
            model: "test",
          },
        },
        local: { enabled: false },
        default: "broken",
      };
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "llm.json"), JSON.stringify(config));

      const mockScraper = {
        async scrape() {
          return {
            ok: true, url: "https://example.com", title: "Test", text: "Test",
            rawHtml: "<html><body>Test</body></html>", engine: "http",
            confidence: "high", status: 200, warnings: [], blocked: false,
          };
        },
      };

      await assert.rejects(
        () => fetchPage(mockScraper, "https://example.com", {
          extract: "summarize",
          stateDir: tmpDir,
        }),
        (error) => {
          assert.ok(error instanceof LlmConfigError, `Expected LlmConfigError, got ${error.constructor.name}`);
          assert.match(error.message, /__REVIEW_FIX_NONEXISTENT_KEY/);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #4: --schema parse error produces structured CLI error
// ---------------------------------------------------------------------------

describe("CLI --schema parse error", () => {
  it("returns structured error for invalid JSON schema, not a stack trace", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");

    const binPath = path.resolve("bin/lupin.js");
    try {
      execFileSync(process.execPath, [binPath, "fetch", "https://example.com", "--schema", "{bad-json"], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.fail("Expected non-zero exit code");
    } catch (error) {
      // Should have exited with code 1
      assert.equal(error.status, 1);
      // stderr should contain structured JSON error, not a stack trace
      const stderr = error.stderr || "";
      const stdout = error.stdout || "";
      const output = stderr + stdout;
      assert.ok(!output.includes("at parseFetchArgs"), "Should not contain stack trace");
      assert.ok(output.includes("Invalid --schema"), "Should contain structured error message");
    }
  });
});
