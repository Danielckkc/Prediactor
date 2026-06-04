import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAvailableRam,
  getGpuInfo,
  selectModelTier,
  selectContextSize,
  getTotalRam,
} from "../../src/runtime/hardware.js";

describe("getAvailableRam", () => {
  it("returns a positive number in bytes", () => {
    const ram = getAvailableRam();
    assert.equal(typeof ram, "number");
    assert.ok(ram > 0);
  });
});

describe("getTotalRam", () => {
  it("returns a positive number in bytes", () => {
    const ram = getTotalRam();
    assert.equal(typeof ram, "number");
    assert.ok(ram > 0);
  });
});

describe("getGpuInfo", () => {
  it("returns an object with type and supported fields", () => {
    const gpu = getGpuInfo();
    assert.equal(typeof gpu.type, "string");
    assert.ok(["metal", "cuda", "none"].includes(gpu.type));
    assert.equal(typeof gpu.supported, "boolean");
  });
});

describe("selectModelTier", () => {
  it("selects q4_k_m for >= 12 GB free", () => {
    const tier = selectModelTier(14 * 1024 ** 3);
    assert.equal(tier.quantization, "Q4_K_M");
    assert.ok(tier.sizeBytes > 0);
  });

  it("selects q3_k_m for >= 5 GB free", () => {
    const tier = selectModelTier(6 * 1024 ** 3);
    assert.equal(tier.quantization, "Q3_K_M");
  });

  it("returns null for < 5 GB free", () => {
    const tier = selectModelTier(4 * 1024 ** 3);
    assert.equal(tier, null);
  });
});

describe("selectContextSize", () => {
  it("returns 32768 for >= 4 GB free after model", () => {
    assert.equal(selectContextSize(5 * 1024 ** 3), 32768);
  });
  it("returns 24576 for 3-4 GB free", () => {
    assert.equal(selectContextSize(3.5 * 1024 ** 3), 24576);
  });
  it("returns 16384 for 2-3 GB free", () => {
    assert.equal(selectContextSize(2.5 * 1024 ** 3), 16384);
  });
  it("returns 8192 for 1-2 GB free", () => {
    assert.equal(selectContextSize(1.5 * 1024 ** 3), 8192);
  });
  it("returns 4096 for < 1 GB free", () => {
    assert.equal(selectContextSize(0.5 * 1024 ** 3), 4096);
  });
});
