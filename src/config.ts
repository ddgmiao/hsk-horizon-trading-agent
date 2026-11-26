import { isAddress, parseUnits } from "ethers";
import { FEE_DENOMINATOR, ONE } from "./strategy.js";

const DEFAULTS = {
  rpcUrl: "https://testnet.hsk.xyz",
  chainId: 133,
  factory: "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
  router: "0xa6914E66690c6794244B5f66a09eAEbf66254237",
  quoter: "0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC",
  token0: "0x0284eA6081C90fd5a48BCCc324C7bE1e46ea8cDb",
  token1: "0xC383e13C47112b76be60f41ef5E5d8f9A8E75aE5",
  pool: "0xf826C65abDFF3B817e846DB4dfB68107CEFeB6b5",
  whsk: "0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6",
  bootstrapPool: "0x9fCdf0d609B36e2C8F8a194BeD2583c772d6EF76",
  bootstrapToken: "0xC383e13C47112b76be60f41ef5E5d8f9A8E75aE5",
  poolFee: 3000,
  targetToken1Bps: 5000,
  rebalanceBandBps: 500,
  maxTradeInput: "0.1",
  maxPositionQuote: "2",
  maxSlippageBps: 100,
  minTradeIntervalSeconds: 300,
  maxDailyLossBps: 500,
  minGasMultiple: 2,
  // Above the measured maximum routine transaction gas of 0.000142 HSK.
  estimatedGasHsk: "0.00015",
  estimatedApprovalGasHsk: "0.000046321",
  estimatedRegistryGasHsk: "0.000035773",
  minTradableNotionalQuote: "0.01",
  bootstrapHsk: "0.01",
  // Measured session gas: 0.000300 HSK for the one-off contract deployment and 0.000036-0.000142 HSK per routine transaction; 0.02 HSK still leaves trade budget after the 0.1 HSK drip.
  hskGasReserve: "0.02",
  pollSeconds: 30,
  maxCycles: 0,
};

export interface AgentConfig {
  rpcUrl: string;
  chainId: number;
  factory: string;
  router: string;
  quoter: string;
  token0: string;
  token1: string;
  pool: string;
  whsk: string;
  bootstrapPool: string;
  bootstrapToken: string;
  poolFee: number;
  targetToken1Bps: number;
  rebalanceBandBps: number;
  maxTradeInput: bigint;
  maxPositionQuote: bigint;
  maxSlippageBps: number;
  minTradeIntervalMs: number;
  maxDailyLossBps: number;
  minGasMultiple: number;
  estimatedGasHsk: bigint;
  estimatedApprovalGasHsk: bigint;
  estimatedRegistryGasHsk: bigint;
  minTradableNotionalQuote: bigint;
  bootstrapHsk: bigint;
  hskGasReserve: bigint;
  pollSeconds: number;
  maxCycles: number;
  logPath: string;
  statePath: string;
}

function intEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const text = process.env[name];
  const value = text === undefined || text === "" ? fallback : Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function addressEnv(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (!isAddress(value)) throw new Error(`${name} is not a valid EVM address`);
  return value;
}

function amountEnv(name: string, fallback: string): bigint {
  const value = process.env[name] || fallback;
  try {
    const parsed = parseUnits(value, 18);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} must be a non-negative decimal amount with at most 18 decimals`);
  }
}

export function loadConfig(): AgentConfig {
  const chainId = intEnv("HSK_CHAIN_ID", DEFAULTS.chainId, 1, 1000000);
  if (chainId !== 133) throw new Error("This build only supports HashKey Chain Testnet (chain ID 133)");

  const maxSlippageBps = intEnv("HSK_MAX_SLIPPAGE_BPS", DEFAULTS.maxSlippageBps, 1, 100);
  const targetToken1Bps = intEnv("HSK_TARGET_TOKEN1_BPS", DEFAULTS.targetToken1Bps, 1, 9999);
  const rebalanceBandBps = intEnv("HSK_REBALANCE_BAND_BPS", DEFAULTS.rebalanceBandBps, 0, 4999);
  const poolFee = intEnv("HSK_POOL_FEE", DEFAULTS.poolFee, 1, Number(FEE_DENOMINATOR) - 1);
  const minGasMultiple = intEnv("HSK_MIN_GAS_MULTIPLE", DEFAULTS.minGasMultiple, 1, 1000);
  const estimatedGasHsk = amountEnv("HSK_ESTIMATED_GAS_HSK", DEFAULTS.estimatedGasHsk);
  if (estimatedGasHsk <= 0n || estimatedGasHsk > ONE) {
    throw new Error("HSK_ESTIMATED_GAS_HSK must be greater than zero and at most 1 HSK");
  }

  const maxTradeInput = amountEnv("HSK_MAX_TRADE_INPUT", DEFAULTS.maxTradeInput);
  const maxPositionQuote = amountEnv("HSK_MAX_POSITION_QUOTE", DEFAULTS.maxPositionQuote);
  const bootstrapHsk = amountEnv("HSK_BOOTSTRAP_HSK", DEFAULTS.bootstrapHsk);
  if (maxTradeInput === 0n || maxPositionQuote === 0n || bootstrapHsk === 0n) {
    throw new Error("Trade input, position cap, and bootstrap amount must be greater than zero");
  }
  if (bootstrapHsk > maxTradeInput) throw new Error("HSK_BOOTSTRAP_HSK cannot exceed HSK_MAX_TRADE_INPUT");

  return {
    rpcUrl: process.env.HSK_RPC_URL || DEFAULTS.rpcUrl,
    chainId,
    factory: addressEnv("HSK_FACTORY", DEFAULTS.factory),
    router: addressEnv("HSK_ROUTER", DEFAULTS.router),
    quoter: addressEnv("HSK_QUOTER", DEFAULTS.quoter),
    token0: addressEnv("HSK_TOKEN0", DEFAULTS.token0),
    token1: addressEnv("HSK_TOKEN1", DEFAULTS.token1),
    pool: addressEnv("HSK_POOL", DEFAULTS.pool),
    whsk: addressEnv("HSK_WHSK", DEFAULTS.whsk),
    bootstrapPool: addressEnv("HSK_BOOTSTRAP_POOL", DEFAULTS.bootstrapPool),
    bootstrapToken: addressEnv("HSK_TOKEN1", DEFAULTS.bootstrapToken),
    poolFee,
    targetToken1Bps,
    rebalanceBandBps,
    maxTradeInput,
    maxPositionQuote,
    maxSlippageBps,
    minTradeIntervalMs: intEnv("HSK_MIN_TRADE_INTERVAL_SECONDS", DEFAULTS.minTradeIntervalSeconds, 0) * 1000,
    maxDailyLossBps: intEnv("HSK_MAX_DAILY_LOSS_BPS", DEFAULTS.maxDailyLossBps, 1, 10000),
    minGasMultiple,
    estimatedGasHsk,
    estimatedApprovalGasHsk: positiveAmountEnv("HSK_ESTIMATED_APPROVAL_GAS_HSK", DEFAULTS.estimatedApprovalGasHsk),
    estimatedRegistryGasHsk: positiveAmountEnv("HSK_ESTIMATED_REGISTRY_GAS_HSK", DEFAULTS.estimatedRegistryGasHsk),
    minTradableNotionalQuote: positiveAmountEnv("HSK_MIN_TRADABLE_NOTIONAL_QUOTE", DEFAULTS.minTradableNotionalQuote, null),
    bootstrapHsk,
    hskGasReserve: amountEnv("HSK_HSK_GAS_RESERVE", DEFAULTS.hskGasReserve),
    pollSeconds: intEnv("HSK_POLL_SECONDS", DEFAULTS.pollSeconds, 1, 3600),
    maxCycles: intEnv("HSK_MAX_CYCLES", DEFAULTS.maxCycles, 0),
    logPath: process.env.HSK_LOG_PATH || "logs/decisions.jsonl",
    statePath: process.env.HSK_STATE_PATH || ".runtime/agent-state.json",
  };
}

function positiveAmountEnv(name: string, fallback: string, maximum: bigint | null = ONE): bigint {
  const value = amountEnv(name, fallback);
  if (value <= 0n || (maximum !== null && value > maximum)) throw new Error(`${name} must be greater than zero${maximum === null ? "" : " and at most 1"}`);
  return value;
}
