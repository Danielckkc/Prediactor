export function createSearchSessionCache(ttlMs) {
  const cache = new WeakMap();

  async function invalidate(manager) {
    const cached = cache.get(manager);
    if (!cached) return;
    cache.delete(manager);
    cached.unregisterCleanup?.();
    await cached.session.close().catch(() => {});
  }

  async function get(manager, timeoutMs) {
    const cached = cache.get(manager);
    const isFresh = cached && Date.now() - cached.lastUsedAt < ttlMs;
    const pageClosed = cached?.session?.page?.isClosed?.() === true;

    if (cached && isFresh && !pageClosed) {
      cached.lastUsedAt = Date.now();
      return cached.session;
    }

    if (cached) {
      await invalidate(manager);
    }

    const session = await manager.openSession({
      engine: "camoufox",
      timeout: timeoutMs,
    });
    let unregisterCleanup = null;
    if (typeof manager.registerCleanup === "function") {
      unregisterCleanup = manager.registerCleanup(async () => {
        await invalidate(manager);
      });
    }
    cache.set(manager, {
      session,
      lastUsedAt: Date.now(),
      unregisterCleanup,
    });
    return session;
  }

  function touch(manager, session) {
    const cached = cache.get(manager);
    if (cached?.session === session) {
      cached.lastUsedAt = Date.now();
    }
  }

  return { get, invalidate, touch };
}
