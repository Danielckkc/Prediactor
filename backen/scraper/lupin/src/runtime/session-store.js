import { randomUUID } from "node:crypto";

import { normalizeEngineName } from "./config.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export class BrowserSessionStore {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.ttlMs = options.ttlMs || manager.config.sessionTtlMs;
    this.sessions = new Map();
    this.sweepIntervalMs = options.sweepIntervalMs || DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = null;
    this.sweepPromise = null;
  }

  startSweepTimer() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepExpiredSessions().catch(() => {});
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stopSweepTimer() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async createSession(options = {}) {
    await this.sweepExpiredSessions();
    const id = randomUUID();
    const engine = normalizeEngineName(options.engine, "fallback");
    const sessionOptions =
      engine === "fallback" && options.ephemeral === undefined
        ? { ...options, ephemeral: true }
        : options;
    const session = await this.manager.openSession(sessionOptions);
    const now = Date.now();
    this.sessions.set(id, {
      id,
      createdAt: now,
      lastUsedAt: now,
      ...session,
    });

    this.startSweepTimer();
    return this.describeSession(this.sessions.get(id));
  }

  async getSession(id) {
    await this.sweepExpiredSessions();
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }

    session.lastUsedAt = Date.now();
    return session;
  }

  async closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.close().catch(() => {});
    if (this.sessions.size === 0) {
      this.stopSweepTimer();
    }
    return true;
  }

  async closeAll() {
    this.stopSweepTimer();
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.closeSession(id);
    }
    await this.manager.close();
  }

  async sweepExpiredSessions() {
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this._doSweep();
    try {
      await this.sweepPromise;
    } finally {
      this.sweepPromise = null;
    }
  }

  async _doSweep() {
    const cutoff = Date.now() - this.ttlMs;
    const expiredIds = Array.from(this.sessions.entries())
      .filter(([, session]) => session.lastUsedAt < cutoff)
      .map(([id]) => id);

    for (const id of expiredIds) {
      await this.closeSession(id);
    }
  }

  describeSession(session) {
    return {
      sessionId: session.id,
      engine: session.engine,
      provider: session.provider,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      defaultTimeoutMs: session.defaultTimeoutMs,
    };
  }
}
