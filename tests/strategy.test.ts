import assert from "node:assert/strict";
import test from "node:test";
import { ABSOLUTE_MAX_SLIPPAGE_BPS, ONE, evaluateRisk, planRebalance, priceX18FromSqrtPrice } from "../src/strategy.js";

test("converts a Uniswap V3 sqrt price to the 18 decimal quote ratio", () => {
  assert.equal(priceX18FromSqrtPrice(2n ** 96n), ONE);
  assert.equal(priceX18FromSqrtPrice(0n + 2n ** 95n), ONE / 4n);
});

test("buys token1 when its portfolio weight is below target", () => {
  const plan = planRebalance({balance0: ONE, balance1: 0n, price1Per0X18: ONE}, {
    targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
  });
  assert.equal(plan.action, "BUY_TOKEN1");
  assert.equal(plan.tokenInIndex, 0);
  assert.equal(plan.amountIn, ONE / 10n);
  assert.equal(plan.deviationBps, -5000);
});

test("sells token1 when its portfolio weight is above target", () => {
  const plan = planRebalance({balance0: 0n, balance1: ONE, price1Per0X18: ONE}, {
    targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
  });
  assert.equal(plan.action, "SELL_TOKEN1");
  assert.equal(plan.tokenInIndex, 1);
  assert.equal(plan.amountIn, ONE / 10n);
  assert.equal(plan.deviationBps, 5000);
});

test("holds inside the allocation band and with no inventory", () => {
  const config = {targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: 2n * ONE};
  assert.equal(planRebalance({balance0: 51n * ONE, balance1: 49n * ONE, price1Per0X18: ONE}, config).action, "HOLD");
  assert.equal(planRebalance({balance0: 0n, balance1: 0n, price1Per0X18: ONE}, config).action, "HOLD");
});

test("risk gates enforce the position cap, slippage ceiling, trade interval, and loss halt", () => {
  const plan = planRebalance({balance0: 0n, balance1: ONE, price1Per0X18: ONE}, {
    targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: ONE / 2n,
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
    targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE / 10n, maxPositionQuote: 2n * ONE,
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
    targetToken1Bps: 5000, rebalanceBandBps: 500, maxTradeInput: ONE, maxPositionQuote: ONE / 4n,
  });
  const checks = evaluateRisk({
    plan, maxTradeInput: ONE, maxPositionQuote: ONE / 4n,
    maxSlippageBps: 100, configuredSlippageBps: 50,
    nowMs: 10000, lastTradeAtMs: null, minTradeIntervalMs: 300000,
    portfolioValueQuote: ONE, dailyStartValueQuote: null, maxDailyLossBps: 500,
  });
  assert.equal(checks.find((check) => check.name === "max_position_size")?.passed, false);
});
