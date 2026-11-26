import { Contract, ContractFactory, JsonRpcProvider, formatUnits, getAddress, parseUnits } from "ethers";
import { resolve } from "node:path";
import { loadConfig, type AgentConfig } from "./config.js";
import { DECISION_LOG_ABI, ERC20_ABI, FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, ROUTER_ABI, WHSK_ABI } from "./abi.js";
import { reconcilePendingSwap, refreshBootstrapBaseline } from "./settlement.js";
import { withAgentLock } from "./locking.js";
import { ReserveError, submitWithReserve } from "./transactions.js";
import { compileDecisionLog } from "./compile.js";
import { appendJsonLine, loadState, restoreLedgerCooldown, saveState, utcDay, type AgentState } from "./persistence.js";
import { assertTestnet, createRuntime, loadAuditDeployment, loadDecisionLogAddress, persistDeployment, type Runtime } from "./runtime.js";
import { ABSOLUTE_MAX_SLIPPAGE_BPS, ceilDiv, evaluateRisk, FEE_DENOMINATOR, ONE, planRebalance, priceX18FromSqrtPrice, type Plan, type RiskCheck } from "./strategy.js";

type Snapshot = {
  blockNumber: number;
  blockHash: string;
  observedAt: string;
  native: bigint;
  whskBalance: bigint;
  sqrtPriceX96: bigint;
  price1Per0X18: bigint;
  bootstrapSqrtPriceX96: bigint;
  token1PerWhskX18: bigint;
  liquidity: bigint;
  balance0: bigint;
  balance1: bigint;
  valueQuote: bigint;
};

type SwapOutcome = {
  status: string;
  swapTxHash: string | null;
  registryTxHash: string | null;
  decisionLogAddress?: string;
  approvalTxHash: string | null;
  amountIn: bigint | null;
  amountOut: bigint | null;
  quoteOut: bigint;
  minOut: bigint;
  error?: string;
  quoteAt?: string | null;
  spotOut?: bigint;
  pathCostHsk?: bigint;
};

export type DecisionRecord = ReturnType<typeof makeDecisionRecord>;

export async function preflight(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  const setup = await verifySetup(runtime);
  const snapshot = await readSnapshot(runtime);
  const state = await loadRiskState(runtime);
  const {plan, riskChecks, execution} = await assessRebalance(runtime, state, snapshot);
  const quoteAmount = parseUnits("0.01", 18);
  const quoteOut = await quoteExactInput(runtime, config.token0, config.token1, quoteAmount, config.poolFee, snapshot.blockNumber);
  const bootstrapQuote = await quoteExactInput(runtime, config.whsk, config.bootstrapToken, quoteAmount, config.poolFee, snapshot.blockNumber);
  const native = snapshot.native;
  const [whskBalance, token0Balance, token1Balance] = await Promise.all([
    new Contract(config.whsk, ERC20_ABI, runtime.provider).balanceOf(runtime.walletAddress, {blockTag: snapshot.blockNumber}) as Promise<bigint>,
    new Contract(config.token0, ERC20_ABI, runtime.provider).balanceOf(runtime.walletAddress, {blockTag: snapshot.blockNumber}) as Promise<bigint>,
    new Contract(config.token1, ERC20_ABI, runtime.provider).balanceOf(runtime.walletAddress, {blockTag: snapshot.blockNumber}) as Promise<bigint>,
  ]);
  let registryAddress: string | null = null;
  try {
    registryAddress = await loadDecisionLogAddress();
  } catch {
    registryAddress = null;
  }
  return {
    status: "read_only_preflight",
    chainId: config.chainId,
    wallet: runtime.walletAddress,
    addresses: {
      factory: config.factory,
      router: config.router,
      quoter: config.quoter,
      pool: config.pool,
      token0: config.token0,
      token1: config.token1,
      whsk: config.whsk,
      bootstrapPool: setup.bootstrapPool,
      decisionLog: registryAddress,
    },
    pool: {
      blockNumber: snapshot.blockNumber,
      blockHash: snapshot.blockHash,
      token0PerToken1: formatUnits(ONE * ONE / snapshot.price1Per0X18, 18),
      token1PerToken0: formatUnits(snapshot.price1Per0X18, 18),
      sqrtPriceX96: snapshot.sqrtPriceX96.toString(),
      liquidity: snapshot.liquidity.toString(),
    },
    quotes: {
      token0In: formatUnits(quoteAmount, 18),
      token1Out: formatUnits(quoteOut, 18),
      whskIn: formatUnits(quoteAmount, 18),
      token1OutFromWhsk: formatUnits(bootstrapQuote, 18),
    },
    gasFloor: {
      token1PerWhsk: formatUnits(snapshot.token1PerWhskX18, 18),
      bootstrapSqrtPriceX96: snapshot.bootstrapSqrtPriceX96.toString(),
      estimatedGasHsk: formatUnits(config.estimatedGasHsk, 18),
      expectedPathCostHsk: formatUnits(execution.pathCostHsk, 18),
      estimatedGasCostToken1: formatUnits(ceilDiv(execution.pathCostHsk * snapshot.token1PerWhskX18, ONE), 18),
      minGasMultiple: config.minGasMultiple,
    },
    rebalance: {action: plan.action, amountIn: formatUnits(plan.amountIn, 18), constraints: riskChecks},
    balances: {
      hsk: formatUnits(native, 18),
      whsk: formatUnits(whskBalance, 18),
      token0: formatUnits(token0Balance, 18),
      token1: formatUnits(token1Balance, 18),
    },
  };
}

export async function observe(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  return withAgentLock(config.statePath, () => observeLocked(runtime));
}

async function observeLocked(runtime: Runtime): Promise<Record<string, unknown>> {
  const {config} = runtime;
  await verifySetup(runtime);
  const snapshot = await readSnapshot(runtime);
  const state = await loadRiskState(runtime);
  if (!state.pendingSwap && !state.bootstrapBaselinePending && state.dailyStartValueQuote === null && snapshot.valueQuote > 0n) {
    state.utcDay = utcDay(Date.now());
    state.dailyStartValueQuote = snapshot.valueQuote.toString();
    await saveState(config.statePath, state);
  }
  const {plan, riskChecks, execution} = await assessRebalance(runtime, state, snapshot);
  const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, {
    status: "observed",
    swapTxHash: null,
    registryTxHash: null,
    approvalTxHash: null,
    amountIn: 0n,
    amountOut: 0n,
    quoteOut: execution.quoteOut,
    minOut: execution.minOut,
    quoteAt: execution.quoteAt,
    spotOut: execution.spotOut, pathCostHsk: execution.pathCostHsk,
  });
  await appendJsonLine(config.logPath, record);
  return record;
}

export async function deployDecisionLog(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  await assertTestnet(runtime.provider, config.chainId);
  const artifact = await compileDecisionLog();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, runtime.wallet);
  const contract = await factory.deploy();
  const deploymentTx = contract.deploymentTransaction();
  if (!deploymentTx) throw new Error("DecisionLog deployment transaction is unavailable");
  const receipt = await deploymentTx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("DecisionLog deployment failed");
  const address = getAddress(await contract.getAddress());
  const result = {
    chainId: 133,
    decisionLog: address,
    deploymentTxHash: deploymentTx.hash,
    deployedAtBlock: receipt.blockNumber,
    deployer: runtime.walletAddress,
  };
  await persistDeployment(result);
  return result;
}

export async function bootstrapOnce(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  return withAgentLock(config.statePath, async () => {
    await assertTestnet(runtime.provider, config.chainId);
    const state = await loadRiskState(runtime);
    const recovered = await reconcilePendingSwap(runtime, state);
    if (recovered) return recovered;
    await refreshBootstrapBaseline(runtime, state);
    if (state.bootstrapBaselinePending) throw new Error("Awaiting positive bootstrap baseline; refusing to trade");
    const setup = await verifySetup(runtime);
    const snapshot = await readSnapshot(runtime);
    return bootstrap(runtime, setup.bootstrapPool, snapshot, state);
  });
}

export async function runAgent(maxCycles = loadConfig().maxCycles, suppliedRuntime?: Runtime): Promise<void> {
  const runtime = suppliedRuntime ?? await createRuntime(loadConfig());
  const {config} = runtime;
  console.log(JSON.stringify({status: "agent_started", chainId: 133, wallet: runtime.walletAddress, maxCycles}));
  let cycle = 0;
  while (maxCycles === 0 || cycle < maxCycles) {
    cycle++;
    try {
      await runCycle(runtime);
    } catch (error) {
      const record = {timestamp: new Date().toISOString(), cycle, status: "cycle_error", error: errorMessage(error)};
      await withAgentLock(config.statePath, () => appendJsonLine(config.logPath, record));
      console.error(JSON.stringify(record));
    }
    if (maxCycles !== 0 && cycle >= maxCycles) break;
    await delay(config.pollSeconds * 1000);
  }
  console.log(JSON.stringify({status: "agent_stopped", cycles: cycle}));
}

export async function auditDecisionLog(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, {staticNetwork: true});
  await assertTestnet(provider, config.chainId);
  const {address, fromBlock, agent} = await loadAuditDeployment();
  if (await provider.getCode(address) === "0x") throw new Error("Configured DecisionLog has no testnet code");
  const latest = await provider.getBlockNumber();
  if (fromBlock > latest) throw new Error(`RPC head ${latest} precedes deployment block ${fromBlock}`);
  const contract = new Contract(address, DECISION_LOG_ABI, provider);
  const events: Awaited<ReturnType<typeof contract.queryFilter>> = [];
  const filter = contract.filters.DecisionLogged!(null, agent);
  for (let start = fromBlock; start <= latest; start += 1000) {
    events.push(...await contract.queryFilter(filter, start, Math.min(latest, start + 999)));
  }
  return {
    chainId: 133,
    decisionLog: address,
    agent,
    fromBlock,
    latestBlock: latest,
    eventCount: events.length,
    events: events.map((event) => ({
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      args: "args" in event ? (event.args.toObject ? event.args.toObject() : event.args) : null,
    })),
  };
}

export async function discoverCandidates(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, {staticNetwork: true});
  await assertTestnet(provider, config.chainId);
  const candidates = [
    "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
    "0x21F8252a908Dc94919Ce7DBce9e5222cE6808212",
    "0x502E2D3F7e79194b858DB1b2a2295d5C06B315FE",
    "0x8e97C632Fc5919fcCe6843fAA242De279a5905ec",
    "0x4Bba6F8eC4c5FC45338F25c75E3f018Aa3DCA48D",
    "0x29b01291dDC6A28007bd4aD5a533c5Ad06b00Df0",
    "0x28f4be0bE8C650E009A767ceA5a074988fF5ac06",
  ];
  const factoryResults = await Promise.all(candidates.map(async (address) => {
    const factory = new Contract(address, FACTORY_ABI, provider);
    const result = await Promise.all([100, 500, 3000, 10000].map(async (fee) => ({fee, pool: await factory.getPool(config.token0, config.token1, fee) as string})));
    return {factory: address, pools: result};
  }));
  return {chainId: 133, pair: [config.token0, config.token1], factoryResults};
}

const activeCycles = new Map<string, Promise<void>>();

export function runCycle(runtime: Runtime, bootstrapPool?: string): Promise<void> {
  const key = resolve(runtime.config.statePath);
  const active = activeCycles.get(key);
  if (active) return active;
  const cycle = withAgentLock(key, () => runCycleLocked(runtime, bootstrapPool)).finally(() => activeCycles.delete(key));
  activeCycles.set(key, cycle);
  return cycle;
}

async function loadRiskState(runtime: Runtime): Promise<AgentState> {
  const state = await loadState(runtime.config.statePath, runtime.walletAddress);
  await restoreLedgerCooldown(runtime.config.logPath, state);
  return state;
}

async function runCycleLocked(runtime: Runtime, bootstrapPool?: string): Promise<void> {
  const {config} = runtime;
  await assertTestnet(runtime.provider, config.chainId);
  const state = await loadRiskState(runtime);
  if (await reconcilePendingSwap(runtime, state)) return;
  await refreshBootstrapBaseline(runtime, state);
  if (state.bootstrapBaselinePending) throw new Error("Awaiting positive bootstrap baseline; refusing to trade");
  const setupPool = bootstrapPool ?? (await verifySetup(runtime)).bootstrapPool;
  const snapshot = await readSnapshot(runtime);
  const bootstrapEligible = !state.bootstrapComplete && snapshot.valueQuote < config.minTradableNotionalQuote;

  if (bootstrapEligible) {
    await bootstrap(runtime, setupPool, snapshot, state);
    return;
  }
  if (!state.bootstrapComplete) {
    state.bootstrapComplete = true;
  }
  if (state.dailyStartValueQuote === null && snapshot.valueQuote > 0n) {
    state.dailyStartValueQuote = snapshot.valueQuote.toString();
  }
  await saveState(config.statePath, state);

  const {plan, riskChecks, execution} = await assessRebalance(runtime, state, snapshot);
  if (plan.action === "HOLD" || riskChecks.some((check) => !check.passed)) {
    const status = plan.action === "HOLD" ? "no_trade" : "risk_blocked";
    const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, {
      status,
      swapTxHash: null,
      registryTxHash: null,
      approvalTxHash: null,
      amountIn: 0n,
      amountOut: 0n,
      quoteOut: execution.quoteOut,
      minOut: execution.minOut,
      quoteAt: execution.quoteAt,
      spotOut: execution.spotOut, pathCostHsk: execution.pathCostHsk,
    });
    await appendJsonLine(config.logPath, record);
    console.log(JSON.stringify({timestamp: record.timestamp, status, action: plan.action, reason: plan.reason}));
    return;
  }

  const tokenIn = plan.tokenInIndex === 0 ? config.token0 : config.token1;
  const tokenOut = plan.tokenInIndex === 0 ? config.token1 : config.token0;
  const record = await executeSwap(runtime, state, {snapshot, tokenIn, tokenOut, plan, riskChecks, execution});
  console.log(JSON.stringify({timestamp: record.timestamp, status: record.execution.status, action: plan.action, txHash: record.execution.swapTxHash, reason: plan.reason}));
}

async function bootstrap(runtime: Runtime, poolAddress: string, snapshot: Snapshot, state: AgentState): Promise<Record<string, unknown>> {
  const {config, wallet, walletAddress} = runtime;
  const now = Date.now();
  const native = snapshot.native;
  const whsk = new Contract(config.whsk, WHSK_ABI, wallet);
  const whskBalance = snapshot.whskBalance;
  if (state.bootstrapComplete || snapshot.valueQuote >= config.minTradableNotionalQuote) {
    state.bootstrapComplete = true;
    await saveState(config.statePath, state);
    return {status: "bootstrap_not_needed", wallet: walletAddress};
  }
  const quoteOut = await quoteExactInput(runtime, config.whsk, config.bootstrapToken, config.bootstrapHsk, config.poolFee, snapshot.blockNumber);
  const quoteAt = new Date(Date.now()).toISOString();
  const hold = (reason: string, riskChecks: RiskCheck[] = []) => recordBootstrapHold(runtime, snapshot, state, reason, riskChecks, quoteOut, quoteAt);

  const bootstrapPoolLiquidity = BigInt(await new Contract(poolAddress, POOL_ABI, runtime.provider).liquidity({blockTag: snapshot.blockNumber}));
  if (bootstrapPoolLiquidity === 0n || quoteOut === 0n) {
    return hold("The WHSK/TT1 bootstrap pool cannot return a nonzero quote.");
  }
  const bootstrapValueQuote = snapshot.balance1 + quoteOut;
  if (bootstrapValueQuote > config.maxPositionQuote) {
    return hold("The bootstrap quote exceeds the configured maximum position.");
  }
  if (native < config.hskGasReserve) {
    return hold("Native HSK is below the configured gas reserve.");
  }
  const amountIn = config.bootstrapHsk;
  const plan: Plan = {
    action: "BUY_TOKEN1",
    amountIn,
    tokenInIndex: 0,
    totalValueQuote: bootstrapValueQuote,
    targetToken1ValueQuote: bootstrapValueQuote,
    currentToken1WeightBps: 0,
    deviationBps: -config.targetToken1Bps,
    reason: "Initial inventory is below the minimum tradable notional; buy a capped TT1 seed from the on-chain WHSK/TT1 pool to start autonomous rebalancing.",
  };
  const riskChecks = evaluateRisk({
    plan,
    maxTradeInput: config.maxTradeInput,
    maxPositionQuote: config.maxPositionQuote,
    maxSlippageBps: ABSOLUTE_MAX_SLIPPAGE_BPS,
    configuredSlippageBps: config.maxSlippageBps,
    nowMs: now,
    lastTradeAtMs: state.lastTradeAtMs,
    minTradeIntervalMs: config.minTradeIntervalMs,
    portfolioValueQuote: 0n,
    dailyStartValueQuote: null,
    maxDailyLossBps: config.maxDailyLossBps,
    // gas_floor applies only to rebalancing; bootstrap must seed inventory.
  });
  if (riskChecks.some((check) => !check.passed)) {
    return hold("A bootstrap risk constraint failed.", riskChecks);
  }

  if (whskBalance < amountIn) {
    const needed = amountIn - whskBalance;
    if (native < needed + config.hskGasReserve) {
      return hold("Insufficient HSK for the configured WHSK seed plus the native gas reserve.", riskChecks);
    }
    const request = await whsk.deposit.populateTransaction({value: needed});
    let wrapTx;
    try {
      wrapTx = await submitWithReserve(runtime, request);
    } catch (error) {
      if (error instanceof ReserveError) return hold(error.message, riskChecks);
      throw error;
    }
    const wrapReceipt = await wrapTx.wait();
    if (!wrapReceipt || wrapReceipt.status !== 1) throw new Error("WHSK deposit transaction failed");
    await appendJsonLine(config.logPath, {
      timestamp: new Date().toISOString(),
      wallet: walletAddress,
      action: "WRAP_HSK",
      amount: formatUnits(needed, 18),
      txHash: wrapTx.hash,
      status: "success",
      reason: "Wrap the configured testnet HSK seed into the router's verified WHSK token before swapping.",
    });
  }

  // Wrapping changes balances and can advance the chain; execution gets a fresh
  // pinned observation while retaining the dust-provisioning disclosure.
  const executionSnapshot = whskBalance < amountIn ? await readSnapshot(runtime) : snapshot;
  const record = await executeSwap(runtime, state, {
    snapshot: executionSnapshot, tokenIn: config.whsk, tokenOut: config.bootstrapToken, plan, riskChecks,
    bootstrapPool: poolAddress,
  });
  console.log(JSON.stringify({timestamp: record.timestamp, status: record.execution.status, action: "BOOTSTRAP", txHash: record.execution.swapTxHash}));
  return record;
}

async function recordBootstrapHold(runtime: Runtime, snapshot: Snapshot, state: AgentState, reason: string, riskChecks: RiskCheck[] = [], quoteOut = 0n, quoteAt: string | null = null): Promise<Record<string, unknown>> {
  const plan: Plan = {
    action: "HOLD", amountIn: 0n, tokenInIndex: null, totalValueQuote: snapshot.valueQuote,
    targetToken1ValueQuote: 0n, currentToken1WeightBps: 0, deviationBps: 0, reason,
  };
  const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, {
    status: "bootstrap_blocked",
    swapTxHash: null,
    registryTxHash: null,
    approvalTxHash: null,
    amountIn: 0n,
    amountOut: 0n,
    quoteOut,
    quoteAt,
    minOut: 0n,
  }, "BOOTSTRAP");
  await appendJsonLine(runtime.config.logPath, record);
  await saveState(runtime.config.statePath, state);
  console.log(JSON.stringify({timestamp: record.timestamp, status: "bootstrap_blocked", reason}));
  return record;
}

type ExecutionQuote = {
  quoteOut: bigint;
  quoteAt: string | null;
  spotOut: bigint;
  minOut: bigint;
  allowance: bigint;
  pathCostHsk: bigint;
};

async function readExecutionQuote(runtime: Runtime, snapshot: Snapshot, plan: Plan, tokenIn: string, tokenOut: string, bootstrap = false): Promise<ExecutionQuote> {
  const {config, provider, walletAddress} = runtime;
  const [quoteOut, allowance] = plan.action === "HOLD" ? [0n, 0n] : await Promise.all([
    quoteExactInput(runtime, tokenIn, tokenOut, plan.amountIn, config.poolFee, snapshot.blockNumber),
    new Contract(tokenIn, ERC20_ABI, provider).allowance(walletAddress, config.router, {blockTag: snapshot.blockNumber}) as Promise<bigint>,
  ]);
  const feeFactor = FEE_DENOMINATOR - BigInt(config.poolFee);
  const spotOut = bootstrap
    ? plan.amountIn * feeFactor * snapshot.token1PerWhskX18 / (FEE_DENOMINATOR * ONE)
    : plan.tokenInIndex === 0
      ? plan.amountIn * feeFactor * snapshot.price1Per0X18 / (FEE_DENOMINATOR * ONE)
      : plan.amountIn * feeFactor * ONE / (FEE_DENOMINATOR * snapshot.price1Per0X18);
  const factor = BigInt(10000 - config.maxSlippageBps);
  const quoteMinimum = ceilDiv(quoteOut * factor, 10000n);
  const spotMinimum = ceilDiv(spotOut * factor, 10000n);
  return {
    quoteOut, quoteAt: plan.action === "HOLD" ? null : new Date(Date.now()).toISOString(), spotOut,
    minOut: quoteMinimum > spotMinimum ? quoteMinimum : spotMinimum,
    allowance: BigInt(allowance),
    pathCostHsk: config.estimatedGasHsk + config.estimatedRegistryGasHsk
      + (allowance < plan.amountIn ? config.estimatedApprovalGasHsk : 0n),
  };
}

function executionChecks(snapshot: Snapshot, plan: Plan, execution: ExecutionQuote): RiskCheck[] {
  return [
    {name: "spot_quote_floor", passed: plan.action === "HOLD" || (execution.quoteOut > 0n && execution.quoteOut >= execution.minOut),
      detail: `quote=${execution.quoteOut}; fee_adjusted_spot=${execution.spotOut}; minimum=${execution.minOut}`},
    {name: "pool_liquidity", passed: plan.action === "HOLD" || snapshot.liquidity > 0n, detail: `liquidity=${snapshot.liquidity}`},
  ];
}

async function assessRebalance(runtime: Runtime, state: AgentState, snapshot: Snapshot) {
  const {config} = runtime;
  const plan = planRebalance(snapshot, config);
  const tokenIn = plan.tokenInIndex === 0 ? config.token0 : config.token1;
  const tokenOut = plan.tokenInIndex === 0 ? config.token1 : config.token0;
  const execution = await readExecutionQuote(runtime, snapshot, plan, tokenIn, tokenOut);
  const riskChecks = [...evaluateRisk(makeRiskInput(config, state, plan, snapshot, Date.now(), execution)),
    ...executionChecks(snapshot, plan, execution)];
  return {plan, riskChecks, execution};
}

async function assessBootstrap(runtime: Runtime, state: AgentState, snapshot: Snapshot, originalPlan: Plan) {
  const {config} = runtime;
  const execution = await readExecutionQuote(runtime, snapshot, originalPlan, config.whsk, config.bootstrapToken, true);
  const position = snapshot.balance1 + execution.quoteOut;
  const plan = {...originalPlan, totalValueQuote: snapshot.valueQuote + execution.quoteOut, targetToken1ValueQuote: position};
  const {gasFloor, ...riskInput} = makeRiskInput(config, state, plan, snapshot, Date.now(), execution);
  const liquidity = BigInt(await new Contract(config.bootstrapPool, POOL_ABI, runtime.provider).liquidity({blockTag: snapshot.blockNumber}));
  const riskChecks = [...evaluateRisk({...riskInput, dailyStartValueQuote: null}),
    ...executionChecks({...snapshot, liquidity}, plan, execution),
    {name: "initial_provisioning", passed: !state.bootstrapComplete && snapshot.valueQuote < config.minTradableNotionalQuote,
      detail: `value=${snapshot.valueQuote}; minimum_tradable_notional=${config.minTradableNotionalQuote}; seeded=${state.bootstrapComplete}`},
  ];
  return {plan, riskChecks, execution};
}

async function executeSwap(runtime: Runtime, state: AgentState, input: {
  snapshot: Snapshot;
  tokenIn: string;
  tokenOut: string;
  plan: Plan;
  riskChecks: RiskCheck[];
  execution?: ExecutionQuote;
  bootstrapPool?: string;
}): Promise<DecisionRecord> {
  const {config, provider, wallet, walletAddress} = runtime;
  let {plan, riskChecks, snapshot} = input;
  let execution: ExecutionQuote;
  if (input.bootstrapPool) {
    ({plan, riskChecks, execution} = await assessBootstrap(runtime, state, snapshot, plan));
  } else {
    execution = input.execution!;
  }
  const registryAddress = await requireDecisionLog(runtime);
  const codes = await Promise.all([input.tokenIn, input.tokenOut, config.router].map(address => provider.getCode(address)));
  if (codes.some(code => code === "0x")) throw new Error("Swap preflight found a configured address without testnet contract code");
  if (input.bootstrapPool) {
    const pool = await new Contract(config.factory, FACTORY_ABI, provider).getPool(input.tokenIn, input.tokenOut, config.poolFee) as string;
    if (getAddress(pool) !== getAddress(input.bootstrapPool)) throw new Error("Bootstrap pool does not match the configured testnet factory result");
  }

  function decisionRecord() {
    return makeDecisionRecord(runtime, snapshot, plan, riskChecks, {
      status: "swap_submitted", swapTxHash: null, registryTxHash: null, decisionLogAddress: registryAddress,
      approvalTxHash: null, amountIn: 0n, amountOut: 0n, quoteOut: execution.quoteOut, minOut: execution.minOut, quoteAt: execution.quoteAt,
      spotOut: execution.spotOut, pathCostHsk: execution.pathCostHsk,
    }, input.bootstrapPool ? "BOOTSTRAP" : "REBALANCE", input.bootstrapPool ? snapshot.bootstrapSqrtPriceX96 : snapshot.sqrtPriceX96);
  }
  let record = decisionRecord();
  async function blocked(reason: string) {
    record.execution.status = input.bootstrapPool ? "bootstrap_blocked" : "risk_blocked";
    record.execution.error = reason;
    await appendJsonLine(config.logPath, record);
    return record;
  }
  if (riskChecks.some(check => !check.passed)) return blocked("An execution risk constraint failed.");

  let swap;
  try {
    if (execution.allowance < plan.amountIn) {
      const original = {blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, observedAt: snapshot.observedAt,
        amountIn: plan.amountIn, tokenIn: input.tokenIn, minOut: execution.minOut, pathCostHsk: execution.pathCostHsk};
      const token = new Contract(input.tokenIn, ERC20_ABI, wallet);
      const approval = await submitWithReserve(runtime, await token.approve.populateTransaction(config.router, plan.amountIn));
      const receipt = await approval.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Exact token approval failed");
      record.execution.approvalTxHash = approval.hash;
      try {
        snapshot = await readSnapshot(runtime);
        ({plan, riskChecks, execution} = input.bootstrapPool
          ? await assessBootstrap(runtime, state, snapshot, plan)
          : await assessRebalance(runtime, state, snapshot));
      } catch (error) {
        return blocked(`Post-approval revalidation failed: ${errorMessage(error)}`);
      }
      const refreshedTokenIn = input.bootstrapPool ? config.whsk : plan.tokenInIndex === 0 ? config.token0 : config.token1;
      if (original.tokenIn === refreshedTokenIn && original.amountIn === plan.amountIn) {
        if (original.minOut > execution.minOut) execution.minOut = original.minOut;
      }
      riskChecks.push({name: "approval_quote_floor", passed: execution.quoteOut >= execution.minOut,
        detail: `refreshed_quote=${execution.quoteOut}; minimum=${execution.minOut}`});
      record = decisionRecord();
      record.execution.approvalTxHash = approval.hash;
      record.approvalRevalidation = {originalBlockNumber: original.blockNumber, originalBlockHash: original.blockHash,
        originalObservedAt: original.observedAt, originalMinimumOut: formatUnits(original.minOut, 18),
        originalExpectedPathCostHsk: formatUnits(original.pathCostHsk, 18)};
      if (execution.quoteOut < execution.minOut) return blocked("Post-approval refreshed quote is below the preserved minimum output.");
      if (plan.action === "HOLD" || riskChecks.some(check => !check.passed)) return blocked("Post-approval plan is HOLD or failed a risk constraint.");
      if (refreshedTokenIn !== input.tokenIn || execution.allowance < plan.amountIn) {
        return blocked("Post-approval refreshed plan requires a different input token or another approval.");
      }
    }
    const balance = input.bootstrapPool ? snapshot.whskBalance : plan.tokenInIndex === 0 ? snapshot.balance0 : snapshot.balance1;
    if (balance < plan.amountIn) return blocked("Insufficient token input balance for planned trade");
    const request = await new Contract(config.router, ROUTER_ABI, wallet).exactInputSingle.populateTransaction({
      tokenIn: input.tokenIn, tokenOut: input.tokenOut, fee: config.poolFee,
      recipient: walletAddress, amountIn: plan.amountIn, amountOutMinimum: execution.minOut, sqrtPriceLimitX96: 0,
    });
    swap = await submitWithReserve(runtime, request, async hash => {
      record.execution.swapTxHash = hash;
      state.pendingSwap = {tokenIn: getAddress(input.tokenIn), tokenOut: getAddress(input.tokenOut),
        pool: getAddress(input.bootstrapPool ?? config.pool), record};
      await saveState(config.statePath, state);
    });
  } catch (error) {
    if (error instanceof ReserveError) return blocked(error.message);
    throw error;
  }
  const receipt = await provider.waitForTransaction(swap.hash, 1);
  if (!receipt) throw new Error(`Awaiting swap receipt ${swap.hash}`);
  await reconcilePendingSwap(runtime, state, receipt);
  return record;
}

async function verifySetup(runtime: Runtime): Promise<{bootstrapPool: string}> {
  const {config, provider} = runtime;
  await assertTestnet(provider, config.chainId);
  const addresses = [config.factory, config.router, config.quoter, config.token0, config.token1, config.pool, config.whsk];
  const code = await Promise.all(addresses.map((address) => provider.getCode(address)));
  if (code.some((item) => item === "0x")) throw new Error("A configured DEX or token address has no contract code on chain ID 133");

  const factory = new Contract(config.factory, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(config.token0, config.token1, config.poolFee) as string;
  if (getAddress(poolAddress) !== getAddress(config.pool)) throw new Error("Configured pool does not match the verified factory getPool result");
  const pool = new Contract(config.pool, POOL_ABI, provider);
  const [token0, token1, fee, liquidity] = await Promise.all([
    pool.token0() as Promise<string>,
    pool.token1() as Promise<string>,
    pool.fee() as Promise<bigint>,
    pool.liquidity() as Promise<bigint>,
  ]);
  if (getAddress(token0) !== getAddress(config.token0) || getAddress(token1) !== getAddress(config.token1)) {
    throw new Error("Pool token order does not match the configured token pair");
  }
  if (Number(fee) !== config.poolFee || BigInt(liquidity) === 0n) throw new Error("Configured pool has the wrong fee or zero active liquidity");

  const bootstrapPool = await factory.getPool(config.whsk, config.bootstrapToken, config.poolFee) as string;
  if (getAddress(bootstrapPool) !== getAddress(config.bootstrapPool)) throw new Error("Configured WHSK/TT1 pool does not match factory getPool");
  const bootstrap = new Contract(bootstrapPool, POOL_ABI, provider);
  const [bootstrapToken0, bootstrapToken1, bootstrapFee, bootstrapLiquidity] = await Promise.all([
    bootstrap.token0() as Promise<string>, bootstrap.token1() as Promise<string>,
    bootstrap.fee() as Promise<bigint>, bootstrap.liquidity() as Promise<bigint>,
  ]);
  const bootstrapTokens = [getAddress(bootstrapToken0), getAddress(bootstrapToken1)];
  if (!bootstrapTokens.includes(getAddress(config.whsk)) || !bootstrapTokens.includes(getAddress(config.bootstrapToken))) {
    throw new Error("Bootstrap pool token pair does not match WHSK/TT1");
  }
  if (Number(bootstrapFee) !== config.poolFee || BigInt(bootstrapLiquidity) === 0n) {
    throw new Error("WHSK/TT1 pool has the wrong fee or zero active liquidity");
  }
  return {bootstrapPool};
}

async function readSnapshot(runtime: Runtime): Promise<Snapshot> {
  const {config, provider, walletAddress} = runtime;
  const pool = new Contract(config.pool, POOL_ABI, provider);
  const bootstrapPool = new Contract(config.bootstrapPool, POOL_ABI, provider);
  const block = await provider.getBlock("latest");
  if (!block || !block.hash) throw new Error("Decision block is unavailable");
  const observedAt = new Date(Date.now()).toISOString();
  const blockNumber = block.number;
  const overrides = {blockTag: blockNumber};
  const [slot0, liquidity, balance0, balance1, bootstrapSlot0, bootstrapToken0, native, whskBalance] = await Promise.all([
    pool.slot0(overrides),
    pool.liquidity(overrides) as Promise<bigint>,
    new Contract(config.token0, ERC20_ABI, provider).balanceOf(walletAddress, overrides) as Promise<bigint>,
    new Contract(config.token1, ERC20_ABI, provider).balanceOf(walletAddress, overrides) as Promise<bigint>,
    bootstrapPool.slot0(overrides),
    bootstrapPool.token0(overrides) as Promise<string>,
    provider.getBalance(walletAddress, blockNumber),
    new Contract(config.whsk, ERC20_ABI, provider).balanceOf(walletAddress, overrides) as Promise<bigint>,
  ]);
  const sqrtPriceX96 = BigInt(slot0[0]);
  const price1Per0X18 = priceX18FromSqrtPrice(sqrtPriceX96);
  const bootstrapSqrtPriceX96 = BigInt(bootstrapSlot0[0]);
  const bootstrapPriceX18 = priceX18FromSqrtPrice(bootstrapSqrtPriceX96);
  if (bootstrapPriceX18 <= 0n) throw new Error("Bootstrap pool price must be positive");
  // slot0 is token1/token0; invert if WHSK is the pool's token1.
  const token1PerWhskX18 = getAddress(bootstrapToken0) === getAddress(config.whsk)
    ? bootstrapPriceX18 : ONE * ONE / bootstrapPriceX18;
  if (token1PerWhskX18 <= 0n) throw new Error("TT1/WHSK price must be positive");
  const valueQuote = (BigInt(balance0) * price1Per0X18) / ONE + BigInt(balance1);
  return {blockNumber, blockHash: block.hash, observedAt, native, whskBalance, sqrtPriceX96, price1Per0X18, bootstrapSqrtPriceX96, token1PerWhskX18, liquidity: BigInt(liquidity), balance0: BigInt(balance0), balance1: BigInt(balance1), valueQuote};
}

async function quoteExactInput(runtime: Runtime, tokenIn: string, tokenOut: string, amountIn: bigint, fee: number, blockTag: number): Promise<bigint> {
  const quoter = new Contract(runtime.config.quoter, QUOTER_V2_ABI, runtime.provider);
  const quoteMethod = quoter.getFunction("quoteExactInputSingle");
  const result = await quoteMethod.staticCall({tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0}, {blockTag});
  return BigInt(result[0]);
}

async function requireDecisionLog(runtime: Runtime): Promise<string> {
  const address = await loadDecisionLogAddress();
  if (await runtime.provider.getCode(address) === "0x") throw new Error("DecisionLog address has no code on chain ID 133");
  return address;
}

function makeRiskInput(config: AgentConfig, state: AgentState, plan: Plan, snapshot: Snapshot, nowMs: number, execution: ExecutionQuote) {
  return {
    plan,
    maxTradeInput: config.maxTradeInput,
    maxPositionQuote: config.maxPositionQuote,
    maxSlippageBps: ABSOLUTE_MAX_SLIPPAGE_BPS,
    configuredSlippageBps: config.maxSlippageBps,
    nowMs,
    lastTradeAtMs: state.lastTradeAtMs,
    minTradeIntervalMs: config.minTradeIntervalMs,
    portfolioValueQuote: snapshot.valueQuote,
    dailyStartValueQuote: state.dailyStartValueQuote === null ? null : BigInt(state.dailyStartValueQuote),
    maxDailyLossBps: config.maxDailyLossBps,
    gasFloor: {
      balance0: snapshot.balance0,
      balance1: snapshot.balance1,
      targetToken1Bps: config.targetToken1Bps,
      quoteOut: execution.quoteOut,
      price1Per0X18: snapshot.price1Per0X18,
      token1PerWhskX18: snapshot.token1PerWhskX18,
      estimatedGasHsk: execution.pathCostHsk,
      minGasMultiple: config.minGasMultiple,
    },
  };
}

function makeDecisionRecord(runtime: Runtime, snapshot: Snapshot, plan: Plan, riskChecks: RiskCheck[], outcome: SwapOutcome, kind = "REBALANCE", priceX96 = snapshot.sqrtPriceX96) {
  return {
    timestamp: snapshot.observedAt,
    observedAt: snapshot.observedAt,
    quoteAt: outcome.quoteAt ?? null,
    fillAt: null as string | null,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    policy: {
      hskGasReserve: formatUnits(runtime.config.hskGasReserve, 18),
      targetToken1Bps: runtime.config.targetToken1Bps, rebalanceBandBps: runtime.config.rebalanceBandBps,
      maxSlippageBps: runtime.config.maxSlippageBps, poolFee: runtime.config.poolFee,
      maxTradeInput: formatUnits(runtime.config.maxTradeInput, 18), maxPositionQuote: formatUnits(runtime.config.maxPositionQuote, 18),
      minTradeIntervalMs: runtime.config.minTradeIntervalMs, maxDailyLossBps: runtime.config.maxDailyLossBps,
      minGasMultiple: runtime.config.minGasMultiple,
      estimatedSwapGasHsk: formatUnits(runtime.config.estimatedGasHsk, 18),
      estimatedApprovalGasHsk: formatUnits(runtime.config.estimatedApprovalGasHsk, 18),
      estimatedRegistryGasHsk: formatUnits(runtime.config.estimatedRegistryGasHsk, 18),
    },
    approvalRevalidation: null as {originalBlockNumber: number; originalBlockHash: string; originalObservedAt: string; originalMinimumOut: string; originalExpectedPathCostHsk: string} | null,
    bootstrap: {minimumTradableNotionalQuote: formatUnits(runtime.config.minTradableNotionalQuote, 18),
      dustRuleFired: kind === "BOOTSTRAP" && snapshot.valueQuote > 0n && snapshot.valueQuote < runtime.config.minTradableNotionalQuote},
    chainId: 133,
    wallet: runtime.walletAddress,
    addresses: {factory: runtime.config.factory, router: runtime.config.router, quoter: runtime.config.quoter, pool: runtime.config.pool, token0: runtime.config.token0, token1: runtime.config.token1},
    prices: {
      token1PerToken0: formatUnits(snapshot.price1Per0X18, 18), sqrtPriceX96: snapshot.sqrtPriceX96.toString(),
      token1PerWhsk: formatUnits(snapshot.token1PerWhskX18, 18), bootstrapSqrtPriceX96: snapshot.bootstrapSqrtPriceX96.toString(),
    },
    balances: {token0: formatUnits(snapshot.balance0, 18), token1: formatUnits(snapshot.balance1, 18), totalValueInToken1: formatUnits(snapshot.valueQuote, 18),
      nativeHsk: formatUnits(snapshot.native, 18), whsk: formatUnits(snapshot.whskBalance, 18)},
    signals: {targetToken1Bps: runtime.config.targetToken1Bps, currentToken1WeightBps: plan.currentToken1WeightBps, deviationBps: plan.deviationBps},
    plan: {kind, action: plan.action, amountIn: formatUnits(plan.amountIn, 18), amountInRaw: plan.amountIn.toString(), reason: plan.reason},
    constraints: riskChecks,
    execution: {
      status: outcome.status,
      quoteOut: formatUnits(outcome.quoteOut, 18),
      feeAdjustedSpotOut: outcome.spotOut === undefined ? null : formatUnits(outcome.spotOut, 18),
      expectedPathCostHsk: outcome.pathCostHsk === undefined ? null : formatUnits(outcome.pathCostHsk, 18),
      minimumOut: formatUnits(outcome.minOut, 18),
      amountIn: outcome.amountIn === null ? null : formatUnits(outcome.amountIn, 18),
      amountOut: outcome.amountOut === null ? null : formatUnits(outcome.amountOut, 18),
      swapTxHash: outcome.swapTxHash,
      approvalTxHash: outcome.approvalTxHash,
      decisionLogTxHash: outcome.registryTxHash,
      decisionLogAddress: outcome.decisionLogAddress || null,
      priceX96: priceX96.toString(),
      ...(outcome.error ? {error: outcome.error} : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown transaction or RPC error";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
