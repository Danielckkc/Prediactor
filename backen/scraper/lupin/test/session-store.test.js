import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSessionStore } from "../src/runtime/session-store.js";

test("browser session store defaults fallback sessions to ephemeral isolation", async () => {
  const calls = [];
  const manager = {
    config: { sessionTtlMs: 60000 },
    openSession: async (options) => {
      calls.push(options);
      return {
        engine: "fallback",
        provider: "patchright",
        defaultTimeoutMs: options.timeout || 1000,
        close: async () => {},
      };
    },
    close: async () => {},
  };

  const store = new BrowserSessionStore(manager);

  try {
    const session = await store.createSession({ engine: "fallback", timeout: 1234 });
    assert.equal(session.engine, "fallback");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ephemeral, true);
    assert.equal(calls[0].timeout, 1234);
  } finally {
    await store.closeAll();
  }
});

test("browser session store preserves explicit ephemeral=false when requested", async () => {
  const calls = [];
  const manager = {
    config: { sessionTtlMs: 60000 },
    openSession: async (options) => {
      calls.push(options);
      return {
        engine: "fallback",
        provider: "patchright",
        defaultTimeoutMs: options.timeout || 1000,
        close: async () => {},
      };
    },
    close: async () => {},
  };

  const store = new BrowserSessionStore(manager);

  try {
    await store.createSession({ engine: "fallback", ephemeral: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ephemeral, false);
  } finally {
    await store.closeAll();
  }
});
