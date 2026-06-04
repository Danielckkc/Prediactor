import os from "node:os";
import { execFileSync } from "node:child_process";

const MODEL_TIERS = [
  {
    quantization: "Q4_K_M",
    filename: "Qwen3.5-4B-Q4_K_M.gguf",
    sizeBytes: 3_400_000_000,
    minRamBytes: 12 * 1024 ** 3,
    label: "Qwen3.5-4B Q4_K_M (3.4 GB)",
  },
  {
    quantization: "Q3_K_M",
    filename: "Qwen3.5-4B-Q3_K_M.gguf",
    sizeBytes: 2_700_000_000,
    minRamBytes: 5 * 1024 ** 3,
    label: "Qwen3.5-4B Q3_K_M (2.7 GB)",
  },
];

export function getAvailableRam() {
  return os.freemem();
}

export function getTotalRam() {
  return os.totalmem();
}

export function getGpuInfo() {
  if (process.platform === "darwin") {
    try {
      const cpuBrand = os.cpus()[0]?.model || "";
      if (cpuBrand.includes("Apple")) {
        return { type: "metal", supported: true };
      }
    } catch {}
    return { type: "none", supported: false };
  }

  if (process.platform === "linux" || process.platform === "win32") {
    try {
      execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
        encoding: "utf8",
        timeout: 5000,
      });
      return { type: "cuda", supported: true };
    } catch {}
  }

  return { type: "none", supported: false };
}

export function selectModelTier(availableRamBytes) {
  for (const tier of MODEL_TIERS) {
    if (availableRamBytes >= tier.minRamBytes) {
      return tier;
    }
  }
  return null;
}

export function selectContextSize(freeRamAfterModelBytes) {
  const gb = freeRamAfterModelBytes / 1024 ** 3;
  if (gb >= 4) return 32768;
  if (gb >= 3) return 24576;
  if (gb >= 2) return 16384;
  if (gb >= 1) return 8192;
  return 4096;
}

export { MODEL_TIERS };
