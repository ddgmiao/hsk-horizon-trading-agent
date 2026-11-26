import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { ONE } from "../src/strategy.js";

const ENV_NAMES = ["HSK_MIN_GAS_MULTIPLE", "HSK_ESTIMATED_GAS_HSK", "HSK_POOL_FEE"];

function withEnv(values: Record<string, string>, run: () => void): void {
  const previous = ENV_NAMES.map((name) => process.env[name]);
  try {
    for (const name of ENV_NAMES) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    run();
  } finally {
    ENV_NAMES.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
}

test("gas_floor configuration defaults to 2x and 0.00015 HSK", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.minGasMultiple, 2);
    assert.equal(config.estimatedGasHsk, 15n * ONE / 100000n);
    assert.equal(config.poolFee, 3000);
  });
});

test("gas_floor configuration accepts overrides and range endpoints", () => {
  for (const multiple of [1, 20, 1000]) {
    withEnv({HSK_MIN_GAS_MULTIPLE: String(multiple), HSK_ESTIMATED_GAS_HSK: "0.000120"}, () => {
      assert.equal(loadConfig().minGasMultiple, multiple);
      assert.equal(loadConfig().estimatedGasHsk, 12n * ONE / 100000n);
    });
  }
  for (const amount of ["0.000000000000000001", "1"]) {
    withEnv({HSK_ESTIMATED_GAS_HSK: amount}, () => assert(loadConfig().estimatedGasHsk > 0n));
  }
});

test("gas_floor configuration rejects invalid multiples and gas estimates", () => {
  for (const value of ["0", "-1", "1001", "2.5", "NaN", "Infinity"]) {
    withEnv({HSK_MIN_GAS_MULTIPLE: value}, () => assert.throws(loadConfig, /HSK_MIN_GAS_MULTIPLE/));
  }
  for (const value of ["0", "-0.0001", "1.000000000000000001", "0.0000000000000000001", "NaN", "Infinity"]) {
    withEnv({HSK_ESTIMATED_GAS_HSK: value}, () => assert.throws(loadConfig, /HSK_ESTIMATED_GAS_HSK/));
  }
});

test("pool fee configuration excludes a 100 percent fee", () => {
  withEnv({HSK_POOL_FEE: "1000000"}, () => assert.throws(loadConfig, /HSK_POOL_FEE/));
});
