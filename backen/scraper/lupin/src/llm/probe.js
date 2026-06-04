import net from "node:net";
import { resolveProviderConfig } from "./config.js";
import { LlmConfigError } from "./errors.js";

const REMOTE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe the resolved LLM provider *before* doing any expensive work (fetching,
 * scraping, etc.) so the user gets a fast, actionable error instead of waiting
 * for a full page load only to see the LLM call fail.
 *
 * Checks:
 *  - Remote: host:port accepts a TCP connection (lightweight socket probe)
 *
 * Both throw on failure — when LLM extraction is requested, there is no point
 * proceeding with the fetch if the LLM is unavailable; the content would end
 * up null anyway after a wasted wait.
 *
 * @param {{ stateDir?: string, llm?: string }} opts
 * @returns {Promise<{ type: string, name: string }>}
 * @throws {LlmConfigError}  On any misconfiguration or unreachable provider
 */
export async function probeProvider({ stateDir, llm } = {}) {
  const provider = resolveProviderConfig({ stateDir, llm });
  return probeRemote(provider);
}

/**
 * Lightweight TCP connect probe — avoids creating full HTTP sockets that
 * linger in the Node.js event loop and delay process exit by ~5 s.
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

async function probeRemote(provider) {
  const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");

  // Deterministic check — missing base URL is a config error
  if (!baseUrl) {
    throw new LlmConfigError(
      `Remote LLM provider "${provider.name}" has no base URL configured.\n` +
      "  Fix: lupin llm add " + provider.name + " --base-url <url> --model <model>"
    );
  }

  // Parse host:port from the base URL for a lightweight TCP probe.
  // We only check that something is listening — HTTP-level errors (401, 404)
  // are the actual LLM call's concern.
  let host, port;
  try {
    const parsed = new URL(baseUrl);
    host = parsed.hostname;
    port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
  } catch {
    throw new LlmConfigError(
      `Remote LLM provider "${provider.name}" has an invalid base URL: ${baseUrl}\n` +
      "  Fix: lupin llm add " + provider.name + " --base-url <url> --model <model>"
    );
  }

  try {
    await tcpProbe(host, Number(port), REMOTE_PROBE_TIMEOUT_MS);
  } catch (err) {
    const reason = err.code === "ECONNREFUSED" ? "connection refused"
      : err.code === "ENOTFOUND" ? "host not found"
      : err.message || "unreachable";

    throw new LlmConfigError(
      `LLM provider "${provider.name}" at ${baseUrl} is not reachable (${reason}).\n` +
      "  Check that the service is running and the base URL is correct.\n" +
      "  Or switch:   lupin llm default <other-provider>\n" +
      "  Or override: --llm <other-provider>"
    );
  }

  return { type: provider.type, name: provider.name };
}
