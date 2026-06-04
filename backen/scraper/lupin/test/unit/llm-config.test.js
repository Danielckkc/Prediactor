import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readLlmConfig,
  writeLlmConfig,
  interpolateEnvVars,
  resolveProviderConfig,
  addProvider,
  removeProvider,
  setDefault,
  listProviders,
} from "../../src/llm/config.js";

describe("interpolateEnvVars", () => {
  it("replaces ${ENV_VAR} with process.env value", () => {
    process.env.__TEST_LLM_KEY = "sk-test-123";
    const result = interpolateEnvVars("${__TEST_LLM_KEY}");
    assert.equal(result, "sk-test-123");
    delete process.env.__TEST_LLM_KEY;
  });

  it("throws for missing env var", () => {
    assert.throws(
      () => interpolateEnvVars("${__NONEXISTENT_VAR_XYZ}"),
      /Environment variable "__NONEXISTENT_VAR_XYZ".*not set/
    );
  });

  it("passes through strings without env vars", () => {
    assert.equal(interpolateEnvVars("plain-string"), "plain-string");
  });
});

describe("readLlmConfig / writeLlmConfig", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-config-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns default config when file does not exist", () => {
    const config = readLlmConfig(tmpDir);
    assert.deepEqual(config.providers, {});
    assert.equal(config.default, null);
  });

  it("round-trips config through write and read", () => {
    const config = {
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "${OPENROUTER_API_KEY}",
          model: "qwen/qwen3.5-4b",
        },
      },
      default: "openrouter",
    };
    writeLlmConfig(tmpDir, config);
    const read = readLlmConfig(tmpDir);
    assert.equal(read.default, "openrouter");
    assert.equal(read.providers.openrouter.model, "qwen/qwen3.5-4b");
  });
});

describe("addProvider", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-add-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("adds a new provider to config", () => {
    addProvider(tmpDir, "myremote", {
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
    });
    const config = readLlmConfig(tmpDir);
    assert.equal(config.providers.myremote.model, "gpt-4o-mini");
  });

  it("sets default when --default flag is used", () => {
    addProvider(tmpDir, "primary", {
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o",
      setAsDefault: true,
    });
    const config = readLlmConfig(tmpDir);
    assert.equal(config.default, "primary");
  });
});

describe("removeProvider", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-rm-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("removes a provider and clears default if it was default", () => {
    addProvider(tmpDir, "victim", {
      baseUrl: "https://api.example.com/v1",
      model: "m",
      setAsDefault: true,
    });
    removeProvider(tmpDir, "victim");
    const config = readLlmConfig(tmpDir);
    assert.equal(config.providers.victim, undefined);
    assert.equal(config.default, null);
  });
});

describe("setDefault", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-default-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("throws for unconfigured provider", () => {
    assert.throws(
      () => setDefault(tmpDir, "nonexistent"),
      /not configured/
    );
  });

  it("sets default to a configured provider", () => {
    addProvider(tmpDir, "ollama", {
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3.5:4b",
    });
    setDefault(tmpDir, "ollama");
    const config = readLlmConfig(tmpDir);
    assert.equal(config.default, "ollama");
  });
});

describe("listProviders", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-list-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty providers when nothing configured", () => {
    const info = listProviders(tmpDir);
    assert.deepEqual(info.providers, {});
    assert.equal(info.default, null);
  });
});

describe("resolveProviderConfig", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-resolve-test-"));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns env-based provider when LUPIN_LLM_BASE_URL is set", () => {
    const origUrl = process.env.LUPIN_LLM_BASE_URL;
    const origModel = process.env.LUPIN_LLM_MODEL;
    process.env.LUPIN_LLM_BASE_URL = "https://inline.example.com/v1";
    process.env.LUPIN_LLM_MODEL = "test-model";
    try {
      const provider = resolveProviderConfig({ stateDir: tmpDir });
      assert.equal(provider.type, "remote");
      assert.equal(provider.baseUrl, "https://inline.example.com/v1");
      assert.equal(provider.model, "test-model");
    } finally {
      if (origUrl === undefined) delete process.env.LUPIN_LLM_BASE_URL;
      else process.env.LUPIN_LLM_BASE_URL = origUrl;
      if (origModel === undefined) delete process.env.LUPIN_LLM_MODEL;
      else process.env.LUPIN_LLM_MODEL = origModel;
    }
  });

  it("returns named provider from config file", () => {
    addProvider(tmpDir, "corp", {
      baseUrl: "https://corp.example.com/v1",
      model: "corp-model",
    });
    const provider = resolveProviderConfig({ stateDir: tmpDir, llm: "corp" });
    assert.equal(provider.type, "remote");
    assert.equal(provider.model, "corp-model");
  });

  it("throws when no LLM configured and no provider specified", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-empty-"));
    try {
      assert.throws(
        () => resolveProviderConfig({ stateDir: emptyDir }),
        /No LLM configured/
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
