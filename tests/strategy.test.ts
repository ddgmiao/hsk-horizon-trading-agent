import assert from "node:assert/strict";
import test from "node:test";
import { ABSOLUTE_MAX_SLIPPAGE_BPS, FEE_DENOMINATOR, ONE, evaluateRisk, planRebalance, priceX18FromSqrtPrice, type Plan, type RiskInput } from "../src/strategy.js";

test("converts a Uniswap V3 sqrt price to the 18 decimal quote ratio", () => {
  assert.equal(priceX18FromSqrtPrice(2n ** 96n), ONE);
  assert.equal(priceX18FromSqrtPrice(0n + 2n ** 95n), ONE / 4n);
});

test("buys token1 when its portfolio weight is below target", () => {
  const plan = planRebalance({balance0: ONE, balance1: 0n, price1Per0X18: ONE}, {
    poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
  });
  assert.equal(plan.action, "BUY_TOKEN1");
  assert.equal(plan.tokenInIndex, 0);
  assert.equal(plan.amountIn, ONE / 10n);
  assert.equal(plan.deviationBps, -5000);
});

test("sells token1 when its portfolio weight is above target", () => {
  const plan = planRebalance({balance0: 0n, balance1: ONE, price1Per0X18: ONE}, {
    poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
  });
  assert.equal(plan.action, "SELL_TOKEN1");
  assert.equal(plan.tokenInIndex, 1);
  assert.equal(plan.amountIn, ONE / 10n);
  assert.equal(plan.deviationBps, 5000);
});

test("holds inside the allocation band and with no inventory", () => {
  const config = {poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: 2n * ONE};
  assert.equal(planRebalance({balance0: 51n * ONE, balance1: 49n * ONE, price1Per0X18: ONE}, config).action, "HOLD");
  assert.equal(planRebalance({balance0: 0n, balance1: 0n, price1Per0X18: ONE}, config).action, "HOLD");
});

test("risk gates enforce the position cap, slippage ceiling, trade interval, and loss halt", () => {
  const plan = planRebalance({balance0: 0n, balance1: ONE, price1Per0X18: ONE}, {
    poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: ONE / 2n,
  });
  const checks = evaluateRisk({
    plan,
    maxTradeInput: ONE,
    maxPositionQuote: ONE / 2n,
    maxSlippageBps: 100,
    configuredSlippageBps: 100,
    nowMs: 2000,
    lastTradeAtMs: 1500,
    minTradeIntervalMs: 1000,
    portfolioValueQuote: 95n * ONE,
    dailyStartValueQuote: 100n * ONE,
    maxDailyLossBps: 500,
  });
  assert.equal(checks.find((check) => check.name === "max_position_size")?.passed, true);
  assert.equal(checks.find((check) => check.name === "min_trade_interval")?.passed, false);
  assert.equal(checks.find((check) => check.name === "daily_loss_halt")?.passed, false);
  assert.equal(checks.find((check) => check.name === "slippage_cap")?.passed, true);
});

test("slippage cap fails when the configured slippage exceeds the absolute ceiling", () => {
  const plan = planRebalance({balance0: ONE, balance1: 0n, price1Per0X18: ONE}, {
    poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
  });
  const base = {
    plan, maxTradeInput: ONE, maxPositionQuote: 2n * ONE,
    nowMs: 10000, lastTradeAtMs: null, minTradeIntervalMs: 300000,
    portfolioValueQuote: ONE, dailyStartValueQuote: null, maxDailyLossBps: 500,
  };
  const over = evaluateRisk({...base, maxSlippageBps: ABSOLUTE_MAX_SLIPPAGE_BPS, configuredSlippageBps: ABSOLUTE_MAX_SLIPPAGE_BPS + 1});
  assert.equal(over.find((check) => check.name === "slippage_cap")?.passed, false);
  const within = evaluateRisk({...base, maxSlippageBps: ABSOLUTE_MAX_SLIPPAGE_BPS, configuredSlippageBps: 100});
  assert.equal(within.find((check) => check.name === "slippage_cap")?.passed, true);
});

test("buy is denied when the target position exceeds the configured cap", () => {
  const plan = planRebalance({balance0: ONE, balance1: 0n, price1Per0X18: ONE}, {
    poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: ONE / 4n,
  });
  const checks = evaluateRisk({
    plan, maxTradeInput: ONE, maxPositionQuote: ONE / 4n,
    maxSlippageBps: 100, configuredSlippageBps: 50,
    nowMs: 10000, lastTradeAtMs: null, minTradeIntervalMs: 300000,
    portfolioValueQuote: ONE, dailyStartValueQuote: null, maxDailyLossBps: 500,
  });
  assert.equal(checks.find((check) => check.name === "max_position_size")?.passed, false);
});

function gasFloorChecks(amountIn: bigint, multiple = 2, tokenInIndex: 0 | 1 = 1, price1Per0X18 = ONE) {
  const plan: Plan = {
    action: tokenInIndex === 0 ? "BUY_TOKEN1" : "SELL_TOKEN1", tokenInIndex, amountIn,
    totalValueQuote: 171953n * ONE / 1000000n,
    targetToken1ValueQuote: 859765n * ONE / 10000000n,
    currentToken1WeightBps: 5501, deviationBps: 501, reason: "Measured band-edge gap fixture",
  };
  const input: RiskInput = {
    plan, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
    maxSlippageBps: ABSOLUTE_MAX_SLIPPAGE_BPS, configuredSlippageBps: 100,
    nowMs: 10000, lastTradeAtMs: null, minTradeIntervalMs: 300000,
    portfolioValueQuote: plan.totalValueQuote, dailyStartValueQuote: null, maxDailyLossBps: 500,
    gasFloor: {
      price1Per0X18, token1PerWhskX18: 1725n * ONE / 100n,
      estimatedGasHsk: 120n * ONE / 1000000n, minGasMultiple: multiple,
    },
  };
  return {input, checks: evaluateRisk(input)};
}

test("gas_floor allows the measured 0.008598 TT1 gap at 2x gas", () => {
  const {checks} = gasFloorChecks(8598n * ONE / 1000000n);
  assert.equal(checks.length, 6);
  assert(checks.every((check) => check.passed));
  const gas = checks.find((check) => check.name === "gas_floor")!;
  assert.match(gas.detail, /estimated_gas_cost_quote=2070000000000000;/);
  assert.match(gas.detail, /minimum_value_quote=4140000000000000$/);
});

test("gas_floor blocks the measured 0.008598 TT1 gap at 20x gas", () => {
  const {checks} = gasFloorChecks(8598n * ONE / 1000000n, 20);
  assert.deepEqual(checks.filter((check) => !check.passed).map((check) => check.name), ["gas_floor"]);
});

test("gas_floor allows an input exactly equal to its threshold", () => {
  const {checks} = gasFloorChecks(414n * ONE / 100000n);
  assert.equal(checks.find((check) => check.name === "gas_floor")?.passed, true);
});

test("gas_floor blocks an input one base unit below its threshold", () => {
  const {checks} = gasFloorChecks(414n * ONE / 100000n - 1n);
  assert.equal(checks.find((check) => check.name === "gas_floor")?.passed, false);
});

test("gas_floor values token0 input at the main price and follows the live WHSK price", () => {
  const {input, checks} = gasFloorChecks(ONE / 100n, 2, 0, ONE / 2n);
  assert.equal(checks.find((check) => check.name === "gas_floor")?.passed, true);
  const changedPrice = evaluateRisk({...input, gasFloor: {...input.gasFloor!, token1PerWhskX18: 2n * input.gasFloor!.token1PerWhskX18}});
  assert.equal(changedPrice.find((check) => check.name === "gas_floor")?.passed, false);
});

test("gas_floor passes HOLD and is absent for the bootstrap risk input", () => {
  const {input} = gasFloorChecks(0n);
  const hold = evaluateRisk({...input, plan: {...input.plan, action: "HOLD", tokenInIndex: null}});
  assert.equal(hold.find((check) => check.name === "gas_floor")?.passed, true);
  const {gasFloor, ...bootstrapInput} = input;
  assert.equal(evaluateRisk(bootstrapInput).length, 5);
  assert.equal(evaluateRisk(bootstrapInput).some((check) => check.name === "gas_floor"), false);
});

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

for (const action of ["BUY_TOKEN1", "SELL_TOKEN1"] as const) {
  for (const targetToken1Bps of [5000, 3000]) {
    test(`fee-aware ${action} settles closer to target ${targetToken1Bps} bps with a 30bps fee`, () => {
      const config = {poolFee: 3000, targetToken1Bps, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: 2n * ONE};
      const price = ONE / 3n;
      const input = {
        balance0: action === "BUY_TOKEN1" ? 3n * ONE / 10n : 0n,
        balance1: action === "SELL_TOKEN1" ? ONE / 10n : 0n,
        price1Per0X18: price,
      };
      const plan = planRebalance(input, config);
      assert.equal(plan.action, action);
      assert(plan.amountIn < config.maxTradeInput);
      const gap = abs(plan.targetToken1ValueQuote - input.balance1);
      const oldInput = action === "BUY_TOKEN1" ? gap * ONE / price : gap;
      function settledDeviation(amountIn: bigint): bigint {
        const afterFee = amountIn * (FEE_DENOMINATOR - BigInt(config.poolFee)) / FEE_DENOMINATOR;
        const output = action === "BUY_TOKEN1" ? afterFee * price / ONE : afterFee * ONE / price;
        const balance0 = input.balance0 + (action === "BUY_TOKEN1" ? -amountIn : output);
        const balance1 = input.balance1 + (action === "BUY_TOKEN1" ? output : -amountIn);
        const total = balance0 * price / ONE + balance1;
        return abs(balance1 * 10000n * ONE / total - BigInt(targetToken1Bps) * ONE);
      }
      const corrected = settledDeviation(plan.amountIn);
      assert(corrected < settledDeviation(oldInput));
      assert(corrected < ONE / 1000n, "Expected fee-adjusted weight to be within 0.001 bps of target");
    });
  }
}

test("fee-aware planning preserves inventory and input caps and rejects invalid fees", () => {
  const input = {balance0: 0n, balance1: ONE / 10n, price1Per0X18: ONE};
  const config = {poolFee: 3000, targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 100n, maxPositionQuote: 2n * ONE};
  assert.equal(planRebalance(input, config).amountIn, config.maxTradeInput);
  const zeroFee = planRebalance(input, {...config, poolFee: 0, maxTradeInput: ONE});
  assert.equal(zeroFee.amountIn, input.balance1 / 2n);
  for (const poolFee of [-1, 0.5, Number(FEE_DENOMINATOR), NaN]) {
    assert.throws(() => planRebalance(input, {...config, poolFee}), /pool fee/);
  }
});
