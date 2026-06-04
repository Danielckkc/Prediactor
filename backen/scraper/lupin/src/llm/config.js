import fs from "node:fs";
import path from "node:path";
import { LlmConfigError } from "./errors.js";

const LLM_CONFIG_FILENAME = "llm.json";

function configPath(stateDir) {
  return path.join(stateDir, LLM_CONFIG_FILENAME);
}

export function interpolateEnvVars(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const val = process.env[name];
    if (val === undefined) {
      throw new LlmConfigError(
        `Environment variable "${name}" referenced in LLM config is not set.\n` +
        `  Set it: export ${name}=<your-value>`
      );
    }
    return val;
  });
}

function interpolateProvider(provider) {
  if (!provider) return provider;
  return {
    ...provider,
    apiKey: provider.apiKey ? interpolateEnvVars(provider.apiKey) : undefined,
    baseUrl: provider.baseUrl ? interpolateEnvVars(provider.baseUrl) : provider.baseUrl,
  };
}

const DEFAULT_CONFIG = {
  providers: {},
  default: null,
};

export function readLlmConfig(stateDir) {
  const filePath = configPath(stateDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function writeLlmConfig(stateDir, config) {
  const filePath = configPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

export function addProvider(stateDir, name, { baseUrl, apiKey, model, setAsDefault }) {
  const config = readLlmConfig(stateDir);
  config.providers[name] = { baseUrl, model };
  if (apiKey) config.providers[name].apiKey = apiKey;
  if (setAsDefault) config.default = name;
  writeLlmConfig(stateDir, config);
}

export function removeProvider(stateDir, name) {
  const config = readLlmConfig(stateDir);
  delete config.providers[name];
  if (config.default === name) config.default = null;
  writeLlmConfig(stateDir, config);
}

export function setDefault(stateDir, name) {
  const config = readLlmConfig(stateDir);
  if (!config.providers[name]) {
    throw new Error(`Provider "${name}" is not configured. Add it first with: lupin llm add ${name}`);
  }
  config.default = name;
  writeLlmConfig(stateDir, config);
}

export function listProviders(stateDir) {
  const config = readLlmConfig(stateDir);
  return {
    default: config.default,
    providers: config.providers,
  };
}

export function resolveProviderConfig({ stateDir, llm } = {}) {
  // Priority 1: Inline env vars (no config file needed)
  const envBaseUrl = process.env.LUPIN_LLM_BASE_URL;
  const envModel = process.env.LUPIN_LLM_MODEL;
  if (envBaseUrl && envModel) {
    return {
      type: "remote",
      name: "env",
      baseUrl: envBaseUrl,
      apiKey: process.env.LUPIN_LLM_API_KEY || undefined,
      model: envModel,
    };
  }

  // Priority 2: LUPIN_LLM_PROVIDER env var overrides --llm flag
  const envProvider = process.env.LUPIN_LLM_PROVIDER;
  const providerName = envProvider || llm;

  const config = readLlmConfig(stateDir);

  // Priority 3: Named provider (from env or --llm flag)
  if (providerName) {
    const provider = config.providers[providerName];
    if (!provider) {
      throw new LlmConfigError(
        `LLM provider "${providerName}" is not configured.\n` +
        `  Add it: lupin llm add ${providerName} --base-url <url> --model <model>\n` +
        `  Or list configured providers: lupin llm list`
      );
    }
    return { type: "remote", name: providerName, ...interpolateProvider(provider) };
  }

  // Priority 4: Config file default
  if (config.default) {
    const provider = config.providers[config.default];
    if (provider) {
      return { type: "remote", name: config.default, ...interpolateProvider(provider) };
    }
  }

  throw new LlmConfigError(
    "No LLM configured.\n" +
    "  Add one: lupin llm add ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b --default\n" +
    "  Or configure a remote provider in ~/.lupin/llm.json"
  );
}
