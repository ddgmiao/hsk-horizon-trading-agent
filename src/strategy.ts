export const Q96 = 2n ** 96n;
export const ONE = 10n ** 18n;
export const FEE_DENOMINATOR = 1000000n;
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
  poolFee: number;
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
  // Supplied only for rebalance plans; bootstrap keeps its existing guards.
  gasFloor?: {
    balance0: bigint;
    balance1: bigint;
    targetToken1Bps: number;
    quoteOut: bigint;
    price1Per0X18: bigint;
    token1PerWhskX18: bigint;
    // Whole remaining path: swap + registry + approval if needed.
    estimatedGasHsk: bigint;
    minGasMultiple: number;
  };
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
  if (!Number.isSafeInteger(config.poolFee) || config.poolFee < 0 || BigInt(config.poolFee) >= FEE_DENOMINATOR) {
    throw new Error("pool fee must be an integer from zero to below the fee denominator");
  }
  const fee = BigInt(config.poolFee);
  const target = BigInt(config.targetToken1Bps);
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

  const allocationErrorScaled = input.balance1 * 10000n - target * totalValueQuote;
  if (abs(allocationErrorScaled) <= BigInt(config.rebalanceBandBps) * totalValueQuote) {
    return holdPlan(totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, "Token1 allocation is inside the rebalance band.");
  }

  if (deviationBps < 0) {
    // Let T be total TT1 value, b the TT1 balance, t the target fraction,
    // f the pool fee and x the input's TT1 value. Buying yields (1-f)*x
    // and total value T-f*x. Solve (b+(1-f)*x)/(T-f*x)=t:
    // x=(t*T-b)/(1-(1-t)*f), then input0=x/price. Keep the ratio
    // unrounded until the final division into token base units.
    const gapScaled = totalValueQuote * target - input.balance1 * 10000n;
    const denominator = 10000n * FEE_DENOMINATOR - (10000n - target) * fee;
    const wantedInput0 = (gapScaled * FEE_DENOMINATOR * ONE) / (denominator * input.price1Per0X18);
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

  // Selling x TT1 leaves b-x TT1 and total value T-f*x. Solve
  // (b-x)/(T-f*x)=t: x=(b-t*T)/(1-t*f). This differs from the buy
  // denominator for targets other than 50%; simply dividing by (1-f)
  // ignores the fee's reduction of the portfolio's total value.
  const gapScaled = input.balance1 * 10000n - totalValueQuote * target;
  const wantedInput1 = (gapScaled * FEE_DENOMINATOR) / (10000n * FEE_DENOMINATOR - target * fee);
  const amountIn = minBigInt(wantedInput1, input.balance1, config.maxTradeInput);
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

  const checks: RiskCheck[] = [
    {name: "max_trade_size", passed: !activeTrade || input.plan.amountIn <= input.maxTradeInput, detail: `input=${input.plan.amountIn}; cap=${input.maxTradeInput}`},
    {name: "max_position_size", passed: !activeTrade || positionCheckPassed, detail: `target_token1_value=${input.plan.targetToken1ValueQuote}; cap=${input.maxPositionQuote}`},
    {name: "slippage_cap", passed: input.configuredSlippageBps <= input.maxSlippageBps, detail: `configured=${input.configuredSlippageBps} bps; absolute_cap=${input.maxSlippageBps} bps`},
    {name: "min_trade_interval", passed: !activeTrade || intervalCheckPassed, detail: `last_trade_ms=${input.lastTradeAtMs ?? "none"}; interval_ms=${input.minTradeIntervalMs}`},
    {name: "daily_loss_halt", passed: lossCheckPassed, detail: `current_value=${input.portfolioValueQuote}; day_start_value=${input.dailyStartValueQuote ?? "unset"}; limit=${input.maxDailyLossBps} bps`},
  ];
  if (input.gasFloor) {
    const {balance0, balance1, targetToken1Bps, quoteOut, price1Per0X18, token1PerWhskX18, estimatedGasHsk, minGasMultiple} = input.gasFloor;
    const buying = input.plan.tokenInIndex === 0;
    const after0 = balance0 + (buying ? -input.plan.amountIn : quoteOut);
    const after1 = balance1 + (buying ? quoteOut : -input.plan.amountIn);
    const beforeValue = balance0 * price1Per0X18 / ONE + balance1;
    const afterValue = after0 * price1Per0X18 / ONE + after1;
    // Keep the target fraction exact through the comparison. The quote includes
    // fees and curvature; both portfolios use the unchanged decision marks.
    const beforeError = abs(balance1 * 10000n - BigInt(targetToken1Bps) * beforeValue);
    const afterError = abs(after1 * 10000n - BigInt(targetToken1Bps) * afterValue);
    const errorRemoved = beforeError - afterError;
    // HSK and WHSK are 1:1; the conversion uses the live bootstrap slot0.
    const gasCostQuote = ceilDiv(estimatedGasHsk * token1PerWhskX18, ONE);
    const minimumValueQuote = ceilDiv(estimatedGasHsk * token1PerWhskX18 * BigInt(minGasMultiple), ONE);
    checks.push({
      name: "gas_floor",
      passed: !activeTrade || (after0 >= 0n && after1 >= 0n && errorRemoved * ONE >= estimatedGasHsk * token1PerWhskX18 * BigInt(minGasMultiple) * 10000n),
      detail: `error_before_scaled=${beforeError}; error_after_scaled=${afterError}; error_removed_scaled=${errorRemoved}; estimated_gas_cost_quote=${gasCostQuote}; min_gas_multiple=${minGasMultiple}; minimum_value_quote=${minimumValueQuote}`,
    });
  }
  return checks;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function holdPlan(totalValueQuote: bigint, targetToken1ValueQuote: bigint, currentToken1WeightBps: number, deviationBps: number, reason: string): Plan {
  return {action: "HOLD", amountIn: 0n, tokenInIndex: null, totalValueQuote, targetToken1ValueQuote, currentToken1WeightBps, deviationBps, reason};
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}
