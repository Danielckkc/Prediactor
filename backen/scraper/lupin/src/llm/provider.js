import { resolveProviderConfig } from "./config.js";

export function resolveProvider({ stateDir, llm }) {
  return resolveProviderConfig({ stateDir, llm });
}
