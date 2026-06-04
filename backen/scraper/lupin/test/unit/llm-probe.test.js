import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { probeProvider } from "../../src/llm/probe.js";
import { writeLlmConfig } from "../../src/llm/config.js";
import { LlmConfigError } from "../../src/llm/errors.js";

describe("probeProvider", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-probe-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("throws LlmConfigError when remote provider has no base URL", async () => {
    writeLlmConfig(tmpDir, {
      providers: { broken: { baseUrl: "", model: "test" } },
      default: "broken",
    });
    await assert.rejects(
      () => probeProvider({ stateDir: tmpDir }),
      (err) => {
        assert.ok(err instanceof LlmConfigError);
        assert.match(err.message, /no base URL configured/);
        return true;
      }
    );
  });

  it("throws LlmConfigError for unreachable remote provider", async () => {
    writeLlmConfig(tmpDir, {
      providers: { dead: { baseUrl: "http://127.0.0.1:1", model: "test" } },
      default: "dead",
    });
    // Should throw — there is no point proceeding with the fetch if the LLM
    // is unreachable; content would end up null anyway after a wasted wait.
    await assert.rejects(
      () => probeProvider({ stateDir: tmpDir }),
      (err) => {
        assert.ok(err instanceof LlmConfigError);
        assert.match(err.message, /not reachable/);
        return true;
      }
    );
  });

  it("succeeds for reachable remote provider", async () => {
    // Use httpbin as a known-reachable public endpoint. If the environment
    // has no outbound network, the probe throws instead — this test only
    // passes when the success path is genuinely exercised.
    writeLlmConfig(tmpDir, {
      providers: {
        httpbin: { baseUrl: "https://httpbin.org", model: "test" },
      },
      default: "httpbin",
    });
    const result = await probeProvider({ stateDir: tmpDir });
    assert.equal(result.type, "remote");
    assert.equal(result.name, "httpbin");
  });
});
