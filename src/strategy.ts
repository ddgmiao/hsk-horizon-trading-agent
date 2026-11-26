export const Q96 = 2n ** 96n;
export const ONE = 10n ** 18n;
// Absolute ceiling for the slippage_cap risk check, independent of the
// configured per-trade slippage so the check compares two distinct sources.
export const ABSOLUTE_MAX_SLIPPAGE_BPS = 1000;

export type Action = "HOLD" | "BUY_TOKEN1" | "SELL_TOKEN1";

export interface RebalanceInput {
  balance0: bigint;
  balance1: bigint;
  price1Per0X18: bigint;
}

export interface StrategyConfig {
  targetToken1Bps: number;
  rebalanceBandBps: number;
  maxTradeInput: bigint;
  maxPositionQuote: bigint;
}

export interface Plan {
  action: Action;
  amountIn: bigint;
  tokenInIndex: 0 | 1 | null;
  totalValueQuote: bigint;
  targetToken1ValueQuote: bigint;
  currentToken1WeightBps: number;
  deviationBps: number;
  reason: string;
}

export interface RiskInput {
  plan: Plan;
  maxTradeInput: bigint;
  maxPositionQuote: bigint;
  maxSlippageBps: number;
  configuredSlippageBps: number;
  nowMs: number;
  lastTradeAtMs: number | null;
  minTradeIntervalMs: number;
  portfolioValueQuote: bigint;
  dailyStartValueQuote: bigint | null;
  maxDailyLossBps: number;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export function priceX18FromSqrtPrice(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error("sqrt price must be positive");
  return (sqrtPriceX96 * sqrtPriceX96 * ONE) / (Q96 * Q96);
}

export function planRebalance(input: RebalanceInput, config: StrategyConfig): Plan {
  if (input.price1Per0X18 <= 0n) throw new Error("price must be positive");
  const token0ValueQuote = (input.balance0 * input.price1Per0X18) / ONE;
  const totalValueQuote = token0ValueQuote + input.balance1;
  const currentToken1WeightBps = totalValueQuote === 0n
    ? 0
    : Number((input.balance1 * 10000n) / totalValueQuote);
  const targetToken1ValueQuote = (totalValueQuote * BigInt(config.targetToken1Bps)) / 10000n;
  const deviationBps = currentToken1WeightBps - config.targetToken1Bps;

  if (totalValueQuote === 0n) {
    return holdPlan(totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, "No inventory; wait for bootstrap funds.");
  }

  if (Math.abs(deviationBps) <= config.rebalanceBandBps) {
    return holdPlan(totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, "Token1 allocation is inside the rebalance band.");
  }

  if (deviationBps < 0) {
    const gapQuote = targetToken1ValueQuote - input.balance1;
    const wantedInput0 = (gapQuote * ONE) / input.price1Per0X18;
    const amountIn = minBigInt(wantedInput0, input.balance0, config.maxTradeInput);
    if (amountIn === 0n) {
      return holdPlan(totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, "Underweight token1, but token0 inventory is below the minimum trade amount.");
    }
    return {
      action: "BUY_TOKEN1",
      amountIn,
      tokenInIndex: 0,
      totalValueQuote,
      targetToken1ValueQuote,
      currentToken1WeightBps,
      deviationBps,
      reason: `Token1 is ${Math.abs(deviationBps)} bps below target; swap token0 toward the ${config.targetToken1Bps} bps allocation.`,
    };
  }

  const gapToken1 = input.balance1 - targetToken1ValueQuote;
  const amountIn = minBigInt(gapToken1, input.balance1, config.maxTradeInput);
  if (amountIn === 0n) {
    return holdPlan(totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, "Overweight token1, but token1 inventory is below the minimum trade amount.");
  }
  return {
    action: "SELL_TOKEN1",
    amountIn,
    tokenInIndex: 1,
    totalValueQuote,
    targetToken1ValueQuote,
    currentToken1WeightBps,
    deviationBps,
    reason: `Token1 is ${deviationBps} bps above target; swap token1 toward the ${config.targetToken1Bps} bps allocation.`,
  };
}

export function evaluateRisk(input: RiskInput): RiskCheck[] {
  const activeTrade = input.plan.action !== "HOLD";
  const positionCheckPassed = input.plan.action !== "BUY_TOKEN1"
    || input.plan.targetToken1ValueQuote <= input.maxPositionQuote;
  const intervalCheckPassed = input.lastTradeAtMs === null
    || input.nowMs - input.lastTradeAtMs >= input.minTradeIntervalMs;
  const lossCheckPassed = input.dailyStartValueQuote === null
    || input.dailyStartValueQuote === 0n
    || input.portfolioValueQuote * 10000n
      > input.dailyStartValueQuote * BigInt(10000 - input.maxDailyLossBps);

  return [
    {name: "max_trade_size", passed: !activeTrade || input.plan.amountIn <= input.maxTradeInput, detail: `input=${input.plan.amountIn}; cap=${input.maxTradeInput}`},
    {name: "max_position_size", passed: !activeTrade || positionCheckPassed, detail: `target_token1_value=${input.plan.targetToken1ValueQuote}; cap=${input.maxPositionQuote}`},
    {name: "slippage_cap", passed: input.configuredSlippageBps <= input.maxSlippageBps, detail: `configured=${input.configuredSlippageBps} bps; absolute_cap=${input.maxSlippageBps} bps`},
    {name: "min_trade_interval", passed: !activeTrade || intervalCheckPassed, detail: `last_trade_ms=${input.lastTradeAtMs ?? "none"}; interval_ms=${input.minTradeIntervalMs}`},
    {name: "daily_loss_halt", passed: lossCheckPassed, detail: `current_value=${input.portfolioValueQuote}; day_start_value=${input.dailyStartValueQuote ?? "unset"}; limit=${input.maxDailyLossBps} bps`},
  ];
}

function holdPlan(totalValueQuote: bigint, targetToken1ValueQuote: bigint, currentToken1WeightBps: number, deviationBps: number, reason: string): Plan {
  return {action: "HOLD", amountIn: 0n, tokenInIndex: null, totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, reason};
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}
