import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatUnits, getAddress, id, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { readFile } from "node:fs/promises";
import { loadConfig, type AgentConfig } from "./config.js";
import { DECISION_LOG_ABI, ERC20_ABI, FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, ROUTER_ABI, WHSK_ABI } from "./abi.js";
import { compileDecisionLog } from "./compile.js";
import { appendJsonLine, loadState, saveState, utcDay, type AgentState } from "./persistence.js";
import { assertTestnet, createRuntime, loadDecisionLogAddress, persistDeployment, type Runtime } from "./runtime.js";
import { evaluateRisk, ONE, planRebalance, priceX18FromSqrtPrice, type Plan, type RiskCheck } from "./strategy.js";

type Snapshot = {
  blockNumber: number;
  sqrtPriceX96: bigint;
  price1Per0X18: bigint;
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
  amountIn: bigint;
  amountOut: bigint;
  quoteOut: bigint;
  minOut: bigint;
  error?: string;
};

const BOOTSTRAP_ACTION_CODE = 3;
const BUY_ACTION_CODE = 1;
const SELL_ACTION_CODE = 2;

export async function preflight(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  const setup = await verifySetup(runtime);
  const snapshot = await readSnapshot(runtime);
  const quoteAmount = parseUnits("0.01", 18);
  const quoteOut = await quoteExactInput(runtime, config.token0, config.token1, quoteAmount, config.poolFee);
  const bootstrapQuote = await quoteExactInput(runtime, config.whsk, config.bootstrapToken, quoteAmount, config.poolFee);
  const native = await runtime.provider.getBalance(runtime.walletAddress);
  const [whskBalance, token0Balance, token1Balance] = await Promise.all([
    new Contract(config.whsk, ERC20_ABI, runtime.provider).balanceOf(runtime.walletAddress) as Promise<bigint>,
    new Contract(config.token0, ERC20_ABI, runtime.provider).balanceOf(runtime.walletAddress) as Promise<bigint>,
    new Contract(config.token1, ERC20_ABI, runtime.provider).balanceOf(runtime.walletAddress) as Promise<bigint>,
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
  await verifySetup(runtime);
  const snapshot = await readSnapshot(runtime);
  const state = await loadState(config.statePath);
  if (state.dailyStartValueQuote === null && snapshot.valueQuote > 0n) {
    state.utcDay = utcDay(Date.now());
    state.dailyStartValueQuote = snapshot.valueQuote.toString();
    await saveState(config.statePath, state);
  }
  const plan = planRebalance({balance0: snapshot.balance0, balance1: snapshot.balance1, price1Per0X18: snapshot.price1Per0X18}, config);
  const riskChecks = evaluateRisk(makeRiskInput(config, state, plan, snapshot.valueQuote, Date.now()));
  const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, {
    status: "observed",
    swapTxHash: null,
    registryTxHash: null,
    approvalTxHash: null,
    amountIn: 0n,
    amountOut: 0n,
    quoteOut: 0n,
    minOut: 0n,
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
  const setup = await verifySetup(runtime);
  const state = await loadState(config.statePath);
  const snapshot = await readSnapshot(runtime);
  return bootstrap(runtime, setup.bootstrapPool, snapshot, state);
}

export async function runAgent(maxCycles = loadConfig().maxCycles): Promise<void> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  const setup = await verifySetup(runtime);
  const registryAddress = await requireDecisionLog(runtime);
  console.log(JSON.stringify({status: "agent_started", chainId: 133, wallet: runtime.walletAddress, decisionLog: registryAddress, maxCycles}));
  let cycle = 0;
  while (maxCycles === 0 || cycle < maxCycles) {
    cycle++;
    try {
      await runCycle(runtime, setup.bootstrapPool);
    } catch (error) {
      const record = {timestamp: new Date().toISOString(), cycle, status: "cycle_error", error: errorMessage(error)};
      await appendJsonLine(config.logPath, record);
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
  const address = await loadDecisionLogAddress();
  if (await provider.getCode(address) === "0x") throw new Error("Configured DecisionLog has no testnet code");
  const latest = await provider.getBlockNumber();
  const contract = new Contract(address, DECISION_LOG_ABI, provider);
  let fromBlock = Math.max(0, latest - 1000);
  try {
    const deployment = JSON.parse(await readFile(".runtime/deployment.json", "utf8")) as {decisionLog?: string; deployedAtBlock?: number};
    if (deployment.decisionLog?.toLowerCase() === address.toLowerCase() && Number.isSafeInteger(deployment.deployedAtBlock)) {
      fromBlock = deployment.deployedAtBlock!;
    }
  } catch {
    // An address supplied outside this workspace falls back to a recent bounded audit window.
  }
  const events: Awaited<ReturnType<typeof contract.queryFilter>> = [];
  const filter = contract.filters.DecisionLogged!(null, null);
  for (let start = fromBlock; start <= latest; start += 1000) {
    events.push(...await contract.queryFilter(filter, start, Math.min(latest, start + 999)));
  }
  return {
    chainId: 133,
    decisionLog: address,
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

async function runCycle(runtime: Runtime, bootstrapPool: string): Promise<void> {
  const {config, walletAddress} = runtime;
  await assertTestnet(runtime.provider, config.chainId);
  const snapshot = await readSnapshot(runtime);
  const balancesEmpty = snapshot.balance0 === 0n && snapshot.balance1 === 0n;
  let state = await loadState(config.statePath);

  if (!state.bootstrapComplete && balancesEmpty) {
    await bootstrap(runtime, bootstrapPool, snapshot, state);
    return;
  }
  if (!state.bootstrapComplete && !balancesEmpty) {
    state.bootstrapComplete = true;
  }
  const day = utcDay(Date.now());
  if (state.utcDay !== day) {
    state.utcDay = day;
    state.dailyStartValueQuote = null;
  }
  if (state.dailyStartValueQuote === null && snapshot.valueQuote > 0n) {
    state.dailyStartValueQuote = snapshot.valueQuote.toString();
  }
  await saveState(config.statePath, state);

  const plan = planRebalance({balance0: snapshot.balance0, balance1: snapshot.balance1, price1Per0X18: snapshot.price1Per0X18}, config);
  const riskChecks = evaluateRisk(makeRiskInput(config, state, plan, snapshot.valueQuote, Date.now()));
  if (plan.action === "HOLD" || riskChecks.some((check) => !check.passed)) {
    const status = plan.action === "HOLD" ? "no_trade" : "risk_blocked";
    const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, {
      status,
      swapTxHash: null,
      registryTxHash: null,
      approvalTxHash: null,
      amountIn: 0n,
      amountOut: 0n,
      quoteOut: 0n,
      minOut: 0n,
    });
    await appendJsonLine(config.logPath, record);
    console.log(JSON.stringify({timestamp: record.timestamp, status, action: plan.action, reason: plan.reason}));
    await saveState(config.statePath, state);
    return;
  }

  const tokenIn = plan.tokenInIndex === 0 ? config.token0 : config.token1;
  const tokenOut = plan.tokenInIndex === 0 ? config.token1 : config.token0;
  const outcome = await executeSwap(runtime, {
    snapshot,
    tokenIn,
    tokenOut,
    fee: config.poolFee,
    amountIn: plan.amountIn,
    plan,
    riskChecks,
    actionCode: plan.action === "BUY_TOKEN1" ? BUY_ACTION_CODE : SELL_ACTION_CODE,
    reason: plan.reason,
  });
  if (outcome.swapTxHash) {
    state.lastTradeAtMs = Date.now();
    const after = await readSnapshot(runtime);
    if (after.valueQuote > 0n && state.dailyStartValueQuote === null) state.dailyStartValueQuote = after.valueQuote.toString();
  }
  await saveState(config.statePath, state);
  const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, outcome);
  await appendJsonLine(config.logPath, record);
  console.log(JSON.stringify({timestamp: record.timestamp, status: outcome.status, action: plan.action, txHash: outcome.swapTxHash, reason: plan.reason}));
}

async function bootstrap(runtime: Runtime, poolAddress: string, snapshot: Snapshot, state: AgentState): Promise<Record<string, unknown>> {
  const {config, wallet, walletAddress} = runtime;
  const now = Date.now();
  const native = await runtime.provider.getBalance(walletAddress);
  const whsk = new Contract(config.whsk, WHSK_ABI, wallet);
  const whskToken = new Contract(config.whsk, ERC20_ABI, runtime.provider);
  const token1 = new Contract(config.bootstrapToken, ERC20_ABI, runtime.provider);
  const [whskBalance, token1Balance, quoteOut] = await Promise.all([
    whskToken.balanceOf(walletAddress) as Promise<bigint>,
    token1.balanceOf(walletAddress) as Promise<bigint>,
    quoteExactInput(runtime, config.whsk, config.bootstrapToken, config.bootstrapHsk, config.poolFee),
  ]);
  if (token1Balance > 0n || snapshot.balance0 > 0n || snapshot.balance1 > 0n) {
    state.bootstrapComplete = true;
    await saveState(config.statePath, state);
    return {status: "bootstrap_not_needed", wallet: walletAddress};
  }

  const bootstrapPoolLiquidity = BigInt(await new Contract(poolAddress, POOL_ABI, runtime.provider).liquidity());
  if (bootstrapPoolLiquidity === 0n || quoteOut === 0n) {
    return recordBootstrapHold(runtime, snapshot, state, "The WHSK/TT1 bootstrap pool cannot return a nonzero quote.");
  }
  const bootstrapValueQuote = quoteOut;
  if (bootstrapValueQuote > config.maxPositionQuote) {
    return recordBootstrapHold(runtime, snapshot, state, "The bootstrap quote exceeds the configured maximum position.");
  }
  if (native < config.hskGasReserve) {
    return recordBootstrapHold(runtime, snapshot, state, "Native HSK is below the configured gas reserve.");
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
    reason: "Wallet has no TT1/TT2 inventory; buy a capped TT1 seed from the on-chain WHSK/TT1 pool to start autonomous rebalancing.",
  };
  const riskChecks = evaluateRisk({
    plan,
    maxTradeInput: config.maxTradeInput,
    maxPositionQuote: config.maxPositionQuote,
    maxSlippageBps: config.maxSlippageBps,
    configuredSlippageBps: config.maxSlippageBps,
    nowMs: now,
    lastTradeAtMs: state.lastTradeAtMs,
    minTradeIntervalMs: config.minTradeIntervalMs,
    portfolioValueQuote: 0n,
    dailyStartValueQuote: null,
    maxDailyLossBps: config.maxDailyLossBps,
  });
  if (riskChecks.some((check) => !check.passed)) {
    return recordBootstrapHold(runtime, snapshot, state, "A bootstrap risk constraint failed.", riskChecks);
  }

  if (whskBalance < amountIn) {
    const needed = amountIn - whskBalance;
    if (native < needed + config.hskGasReserve) {
      return recordBootstrapHold(runtime, snapshot, state, "Insufficient HSK for the configured WHSK seed plus the native gas reserve.", riskChecks);
    }
    await assertTestnet(runtime.provider, config.chainId);
    const wrapTx = await whsk.deposit({value: needed});
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

  const bootstrapPool = new Contract(poolAddress, POOL_ABI, runtime.provider);
  const bootstrapSlot = await bootstrapPool.slot0();
  const priceX96 = BigInt(bootstrapSlot[0]);
  const outcome = await executeSwap(runtime, {
    snapshot,
    tokenIn: config.whsk,
    tokenOut: config.bootstrapToken,
    fee: config.poolFee,
    amountIn,
    plan,
    riskChecks,
    actionCode: BOOTSTRAP_ACTION_CODE,
    reason: plan.reason,
    priceX96,
    expectedPool: poolAddress,
  });
  if (outcome.swapTxHash) {
    state.lastTradeAtMs = Date.now();
    state.bootstrapComplete = true;
    const after = await readSnapshot(runtime);
    state.dailyStartValueQuote = after.valueQuote > 0n ? after.valueQuote.toString() : null;
    state.utcDay = utcDay(Date.now());
  }
  await saveState(config.statePath, state);
  const record = makeDecisionRecord(runtime, snapshot, plan, riskChecks, outcome, "BOOTSTRAP", priceX96);
  await appendJsonLine(config.logPath, record);
  console.log(JSON.stringify({timestamp: record.timestamp, status: outcome.status, action: "BOOTSTRAP", txHash: outcome.swapTxHash}));
  return record;
}

async function recordBootstrapHold(runtime: Runtime, snapshot: Snapshot, state: AgentState, reason: string, riskChecks: RiskCheck[] = []): Promise<Record<string, unknown>> {
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
    quoteOut: 0n,
    minOut: 0n,
  }, "BOOTSTRAP");
  await appendJsonLine(runtime.config.logPath, record);
  await saveState(runtime.config.statePath, state);
  console.log(JSON.stringify({timestamp: record.timestamp, status: "bootstrap_blocked", reason}));
  return record;
}

async function executeSwap(runtime: Runtime, input: {
  snapshot: Snapshot;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  plan: Plan;
  riskChecks: RiskCheck[];
  actionCode: number;
  reason: string;
  priceX96?: bigint;
  expectedPool?: string;
}): Promise<SwapOutcome> {
  const {config, provider, wallet, walletAddress} = runtime;
  const registryAddress = await requireDecisionLog(runtime);
  const registry = new Contract(registryAddress, DECISION_LOG_ABI, provider);
  const [inputCode, outputCode, routerCode, registryCode] = await Promise.all([
    provider.getCode(input.tokenIn), provider.getCode(input.tokenOut), provider.getCode(config.router), provider.getCode(registryAddress),
  ]);
  if ([inputCode, outputCode, routerCode, registryCode].some((code) => code === "0x")) throw new Error("Swap preflight found a configured address without testnet contract code");
  if (input.expectedPool) {
    const pool = await new Contract(config.factory, FACTORY_ABI, provider).getPool(input.tokenIn, input.tokenOut, input.fee) as string;
    if (getAddress(pool) !== getAddress(input.expectedPool)) throw new Error("Bootstrap pool does not match the configured testnet factory result");
  }
  const quoteOut = await quoteExactInput(runtime, input.tokenIn, input.tokenOut, input.amountIn, input.fee);
  if (quoteOut <= 0n) throw new Error("Quoter returned zero output; refusing to swap");
  const minOut = (quoteOut * BigInt(10000 - config.maxSlippageBps)) / 10000n;
  const tokenIn = new Contract(input.tokenIn, ERC20_ABI, wallet);
  const tokenOut = new Contract(input.tokenOut, ERC20_ABI, provider);
  const beforeInput = BigInt(await tokenIn.balanceOf(walletAddress));
  const beforeOutput = BigInt(await tokenOut.balanceOf(walletAddress));
  if (beforeInput < input.amountIn) throw new Error("Insufficient token input balance for planned trade");

  let approvalTxHash: string | null = null;
  const allowance = BigInt(await new Contract(input.tokenIn, ERC20_ABI, provider).allowance(walletAddress, config.router));
  if (allowance < input.amountIn) {
    await assertTestnet(provider, config.chainId);
    const approval = await tokenIn.approve(config.router, input.amountIn);
    const approvalReceipt = await approval.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) throw new Error("Exact token approval failed");
    approvalTxHash = approval.hash;
  }

  await assertTestnet(provider, config.chainId);
  const router = new Contract(config.router, ROUTER_ABI, wallet);
  const tx = await router.exactInputSingle({
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    fee: input.fee,
    recipient: walletAddress,
    amountIn: input.amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("SwapRouter02 transaction failed");
  const afterInput = BigInt(await tokenIn.balanceOf(walletAddress));
  const afterOutput = BigInt(await tokenOut.balanceOf(walletAddress));
  const actualInput = beforeInput - afterInput;
  const actualOutput = afterOutput - beforeOutput;
  if (actualInput <= 0n || actualOutput < minOut) throw new Error("Swap receipt balances did not satisfy the signed amount bounds");

  let registryTxHash: string | null = null;
  let registryError: string | undefined;
  try {
    await assertTestnet(provider, config.chainId);
    const boundRegistry = registry.connect(wallet) as Contract;
    const timestamp = Math.floor(Date.now() / 1000);
    const priceX96 = input.priceX96 ?? input.snapshot.sqrtPriceX96;
    const decisionId = id(`${walletAddress}:${tx.hash}:${timestamp}`);
    const reasonHash = keccak256(toUtf8Bytes(input.reason));
    const deviation = BigInt(input.plan.deviationBps);
    const logTx = await boundRegistry.record(
      decisionId,
      timestamp,
      deviation,
      input.actionCode,
      priceX96,
      actualInput,
      actualOutput,
      tx.hash,
      reasonHash,
    );
    const logReceipt = await logTx.wait();
    if (!logReceipt || logReceipt.status !== 1) throw new Error("DecisionLog transaction failed");
    registryTxHash = logTx.hash;
  } catch (error) {
    registryError = errorMessage(error);
  }

  return {
    status: registryError ? "swap_success_registry_failed" : "success",
    swapTxHash: tx.hash,
    registryTxHash,
    decisionLogAddress: registryAddress,
    approvalTxHash,
    amountIn: actualInput,
    amountOut: actualOutput,
    quoteOut,
    minOut,
    ...(registryError ? {error: `Swap succeeded but on-chain decision logging failed: ${registryError}`} : {}),
  };
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
  const bootstrapLiquidity = BigInt(await new Contract(bootstrapPool, POOL_ABI, provider).liquidity());
  if (bootstrapLiquidity === 0n) throw new Error("WHSK/TT1 pool has zero active liquidity");
  return {bootstrapPool};
}

async function readSnapshot(runtime: Runtime): Promise<Snapshot> {
  const {config, provider, walletAddress} = runtime;
  const pool = new Contract(config.pool, POOL_ABI, provider);
  const [slot0, liquidity, balance0, balance1, blockNumber] = await Promise.all([
    pool.slot0(),
    pool.liquidity() as Promise<bigint>,
    new Contract(config.token0, ERC20_ABI, provider).balanceOf(walletAddress) as Promise<bigint>,
    new Contract(config.token1, ERC20_ABI, provider).balanceOf(walletAddress) as Promise<bigint>,
    provider.getBlockNumber(),
  ]);
  const sqrtPriceX96 = BigInt(slot0[0]);
  const price1Per0X18 = priceX18FromSqrtPrice(sqrtPriceX96);
  const valueQuote = (BigInt(balance0) * price1Per0X18) / ONE + BigInt(balance1);
  return {blockNumber, sqrtPriceX96, price1Per0X18, liquidity: BigInt(liquidity), balance0: BigInt(balance0), balance1: BigInt(balance1), valueQuote};
}

async function quoteExactInput(runtime: Runtime, tokenIn: string, tokenOut: string, amountIn: bigint, fee: number): Promise<bigint> {
  const quoter = new Contract(runtime.config.quoter, QUOTER_V2_ABI, runtime.provider);
  const quoteMethod = quoter.getFunction("quoteExactInputSingle");
  const result = await quoteMethod.staticCall({tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0});
  return BigInt(result[0]);
}

async function requireDecisionLog(runtime: Runtime): Promise<string> {
  const address = await loadDecisionLogAddress();
  if (await runtime.provider.getCode(address) === "0x") throw new Error("DecisionLog address has no code on chain ID 133");
  return address;
}

function makeRiskInput(config: AgentConfig, state: AgentState, plan: Plan, portfolioValueQuote: bigint, nowMs: number) {
  return {
    plan,
    maxTradeInput: config.maxTradeInput,
    maxPositionQuote: config.maxPositionQuote,
    maxSlippageBps: config.maxSlippageBps,
    configuredSlippageBps: config.maxSlippageBps,
    nowMs,
    lastTradeAtMs: state.lastTradeAtMs,
    minTradeIntervalMs: config.minTradeIntervalMs,
    portfolioValueQuote,
    dailyStartValueQuote: state.dailyStartValueQuote === null ? null : BigInt(state.dailyStartValueQuote),
    maxDailyLossBps: config.maxDailyLossBps,
  };
}

function makeDecisionRecord(runtime: Runtime, snapshot: Snapshot, plan: Plan, riskChecks: RiskCheck[], outcome: SwapOutcome, kind = "REBALANCE", priceX96 = snapshot.sqrtPriceX96) {
  return {
    timestamp: new Date().toISOString(),
    blockNumber: snapshot.blockNumber,
    chainId: 133,
    wallet: runtime.walletAddress,
    addresses: {factory: runtime.config.factory, router: runtime.config.router, quoter: runtime.config.quoter, pool: runtime.config.pool, token0: runtime.config.token0, token1: runtime.config.token1},
    prices: {token1PerToken0: formatUnits(snapshot.price1Per0X18, 18), sqrtPriceX96: snapshot.sqrtPriceX96.toString()},
    balances: {token0: formatUnits(snapshot.balance0, 18), token1: formatUnits(snapshot.balance1, 18), totalValueInToken1: formatUnits(snapshot.valueQuote, 18)},
    signals: {targetToken1Bps: runtime.config.targetToken1Bps, currentToken1WeightBps: plan.currentToken1WeightBps, deviationBps: plan.deviationBps},
    plan: {kind, action: plan.action, amountIn: formatUnits(plan.amountIn, 18), amountInRaw: plan.amountIn.toString(), reason: plan.reason},
    constraints: riskChecks,
    execution: {
      status: outcome.status,
      quoteOut: formatUnits(outcome.quoteOut, 18),
      minimumOut: formatUnits(outcome.minOut, 18),
      amountIn: formatUnits(outcome.amountIn, 18),
      amountOut: formatUnits(outcome.amountOut, 18),
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
