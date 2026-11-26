import { Contract, Interface, Transaction, formatUnits, getAddress, id, keccak256, parseUnits, type Log, type TransactionReceipt } from "ethers";
import { DECISION_LOG_ABI, ERC20_ABI, POOL_ABI } from "./abi.js";
import type { DecisionRecord } from "./agent.js";
import { appendJsonLine, findSwapRecord, isFill, saveState, utcDay, type AgentState, type PendingSwap } from "./persistence.js";
import type { Runtime } from "./runtime.js";
import { broadcastWithReserve, submitWithReserve } from "./transactions.js";
import { ONE, priceX18FromSqrtPrice } from "./strategy.js";

const tokenEvents = new Interface(ERC20_ABI);
const poolEvents = new Interface(POOL_ABI);
const transferTopic = tokenEvents.getEvent("Transfer")!.topicHash;
const swapTopic = poolEvents.getEvent("Swap")!.topicHash;

export function receiptFill(logs: readonly Pick<Log, "address" | "topics" | "data">[], pending: PendingSwap) {
  const {record} = pending;
  const tokenIn = getAddress(pending.tokenIn);
  const tokenOut = getAddress(pending.tokenOut);
  const pool = getAddress(pending.pool);
  const wallet = getAddress(record.wallet);
  let transferredIn: bigint | null = null;
  let transferredOut: bigint | null = null;
  let poolIn = 0n;
  let poolOut = 0n;
  let sawSwap = false;
  for (const log of logs) {
    const emitter = getAddress(log.address);
    if (log.topics[0] === transferTopic && (emitter === tokenIn || emitter === tokenOut)) {
      const {from, to, value} = tokenEvents.decodeEventLog("Transfer", log.data, log.topics);
      if (emitter === tokenIn && from === wallet && to === pool) transferredIn = (transferredIn ?? 0n) + value;
      if (emitter === tokenOut && from === pool && to === wallet) transferredOut = (transferredOut ?? 0n) + value;
    }
    if (emitter === pool && log.topics[0] === swapTopic) {
      const {sender, recipient, amount0, amount1} = poolEvents.decodeEventLog("Swap", log.data, log.topics);
      if (sender !== getAddress(record.addresses.router) || recipient !== wallet) continue;
      // V3 orders token0 and token1 by address.
      const inputIsToken0 = BigInt(tokenIn) < BigInt(tokenOut);
      poolIn += inputIsToken0 ? amount0 : amount1;
      poolOut -= inputIsToken0 ? amount1 : amount0;
      sawSwap = true;
    }
  }
  const amountIn = transferredIn ?? (sawSwap && poolIn >= 0n ? poolIn : null);
  const amountOut = transferredOut ?? (sawSwap && poolOut >= 0n ? poolOut : null);
  const signedInput = BigInt(record.plan.amountInRaw);
  const minOut = parseUnits(record.execution.minimumOut, 18);
  let error: string | undefined;
  if (amountIn === null || amountOut === null) {
    error = "Receipt lacks attributable fill amounts. DecisionLog write skipped.";
  } else if (amountIn !== signedInput || amountIn === 0n || amountOut < minOut) {
    error = `Receipt amounts outside signed bounds (actualInput=${amountIn}, signedInput=${signedInput}, actualOutput=${amountOut}, minOut=${minOut})`;
  } else if (sawSwap && (amountIn !== poolIn || amountOut !== poolOut)) {
    error = `Receipt transfers disagree with the pool Swap (poolInput=${poolIn}, poolOutput=${poolOut})`;
  }
  return {amountIn, amountOut, error};
}

async function recordOnChain(runtime: Runtime, state: AgentState, record: DecisionRecord) {
  const execution = record.execution;
  const pending = state.pendingSwap!;
  const registry = new Contract(execution.decisionLogAddress!, DECISION_LOG_ABI, runtime.wallet);
  if (!pending.registryCall) {
    const timestamp = Math.floor(Date.parse(record.observedAt ?? record.timestamp) / 1000);
    const actionCode = record.plan.kind === "BOOTSTRAP" ? 3 : record.plan.action === "BUY_TOKEN1" ? 1 : 2;
    pending.registryCall = {args: [
      id(`${record.wallet}:${execution.swapTxHash}:${timestamp}`), String(timestamp), String(record.signals.deviationBps),
      String(actionCode), execution.priceX96, String(parseUnits(execution.amountIn!, 18)), String(parseUnits(execution.amountOut!, 18)),
      execution.swapTxHash!, id(record.plan.reason),
    ]};
    await saveState(runtime.config.statePath, state);
  }
  const request = await registry.record.populateTransaction(...pending.registryCall.args);
  let receipt: TransactionReceipt | null;
  if (execution.decisionLogTxHash) {
    receipt = await runtime.provider.getTransactionReceipt(execution.decisionLogTxHash);
    if (!receipt) {
      // Give an in-flight transaction a bounded chance to land, then rebroadcast
      // the identical envelope/nonce. This cannot create a second registry call.
      try { receipt = await runtime.provider.waitForTransaction(execution.decisionLogTxHash, 1, 5000); }
      catch (error) {
        if ((error as {code?: string}).code !== "TIMEOUT") throw error;
      }
      if (!receipt) {
        const signed = pending.registryCall.signedTransaction;
        if (!signed) throw new Error("Legacy registry journal lacks signed retry payload; refusing an ambiguous replacement");
        const tx = Transaction.from(signed);
        if (keccak256(signed) !== execution.decisionLogTxHash || tx.data !== request.data
          || tx.to !== getAddress(execution.decisionLogAddress!) || tx.chainId !== 133n
          || tx.from !== getAddress(record.wallet)) throw new Error("Registry retry payload does not match journal");
        try { await broadcastWithReserve(runtime, signed); }
        catch (error) {
          // Already-known/nonce-too-low can mean the original landed during retry.
          receipt = await runtime.provider.getTransactionReceipt(execution.decisionLogTxHash);
          if (!receipt) throw error;
        }
        receipt ??= await runtime.provider.waitForTransaction(execution.decisionLogTxHash, 1, 15000);
      }
    }
  } else {
    const tx = await submitWithReserve(runtime, request, async (hash, signed) => {
      execution.decisionLogTxHash = hash;
      pending.registryCall!.signedTransaction = signed;
      await saveState(runtime.config.statePath, state);
    });
    receipt = await runtime.provider.waitForTransaction(tx.hash, 1, 15000);
  }
  if (!receipt || receipt.status === null) throw new Error(`Awaiting DecisionLog receipt ${execution.decisionLogTxHash}`);
  return receipt.status === 1;
}

// Both startup and normal execution complete the same journal entry. An
// unknown receipt keeps the entry pending and prevents a second submission.
export async function reconcilePendingSwap(runtime: Runtime, state: AgentState, mined?: TransactionReceipt): Promise<DecisionRecord | null> {
  const pending = state.pendingSwap;
  if (!pending) return null;
  const {record} = pending;
  const {execution} = record;
  const {logPath, statePath} = runtime.config;
  const hash = execution.swapTxHash!;
  if (!mined) {
    const existing = await findSwapRecord(logPath, record.wallet, hash);
    if (existing) {
      if (isFill(existing)) {
        state.lastTradeAtMs = Math.max(state.lastTradeAtMs ?? 0, Date.parse(existing.fillAt ?? existing.timestamp));
        if (existing.plan.kind === "BOOTSTRAP") {
          state.bootstrapComplete = true;
          if (state.dailyStartValueQuote === null) state.bootstrapBaselinePending = true;
        }
      }
      state.pendingSwap = null;
      await saveState(statePath, state);
      await refreshBootstrapBaseline(runtime, state);
      return existing;
    }
  }
  if (execution.status === "swap_submitted") {
    const receipt = mined ?? await runtime.provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status === null) throw new Error(`Awaiting swap receipt ${hash}; refusing another trade`);
    if (receipt.hash !== hash || getAddress(receipt.from) !== getAddress(record.wallet)
      || !receipt.to || getAddress(receipt.to) !== getAddress(record.addresses.router)) {
      throw new Error(`Swap receipt does not match the pending transaction ${hash}`);
    }
    if (receipt.status === 1) {
      const block = await runtime.provider.getBlock(receipt.blockHash);
      if (!block) throw new Error(`Awaiting block timestamp for swap ${hash}`);
      const fillTime = block.timestamp * 1000;
      state.lastTradeAtMs = Math.max(state.lastTradeAtMs ?? 0, fillTime);
      record.observedAt ??= record.timestamp;
      record.fillAt = new Date(fillTime).toISOString();
      // Keep the legacy timestamp as a fill-time alias for existing consumers.
      // observedAt remains the signal time used by the registry.
      record.timestamp = record.fillAt;
      if (record.plan.kind === "BOOTSTRAP") {
        state.bootstrapComplete = true;
        state.bootstrapBaselinePending = true;
      }
      try {
        const fill = receiptFill(receipt.logs, pending);
        execution.amountIn = fill.amountIn === null ? null : formatUnits(fill.amountIn, 18);
        execution.amountOut = fill.amountOut === null ? null : formatUnits(fill.amountOut, 18);
        execution.status = fill.error ? "swap_success_bounds_violation" : "success";
        if (fill.error) execution.error = fill.error;
      } catch (error) {
        execution.status = "swap_success_bounds_violation";
        execution.amountIn = null;
        execution.amountOut = null;
        execution.error = `Could not decode swap receipt. DecisionLog write skipped. ${error instanceof Error ? error.message : ""}`;
      }
    } else {
      execution.status = "swap_reverted";
    }
    await saveState(statePath, state);
  }

  // Round-2 confirmed journals predate the durable baseline-refresh flag.
  if (isFill(record) && record.plan.kind === "BOOTSTRAP" && !state.bootstrapBaselinePending) {
    state.bootstrapComplete = true;
    state.bootstrapBaselinePending = true;
    await saveState(statePath, state);
  }

  if ((execution.status === "success" || execution.status === "swap_success_bounds_violation")
      && execution.amountIn !== null && execution.amountOut !== null) {
    let registryError: string | undefined;
    try {
      if (!await recordOnChain(runtime, state, record)) registryError = "DecisionLog transaction reverted";
    } catch (error) {
      // Once its hash is durable, a timeout is ambiguous. Reconcile it on
      // the next poll without submitting a duplicate permissionless record.
      if (execution.decisionLogTxHash) throw error;
      registryError = error instanceof Error ? error.message : "DecisionLog RPC error";
    }
    if (registryError) {
      if (execution.status === "success") execution.status = "swap_success_registry_failed";
      execution.error = [execution.error, `On-chain decision logging failed: ${registryError}`].filter(Boolean).join(". ");
    }
  }
  await appendJsonLine(logPath, record);
  state.pendingSwap = null;
  await saveState(statePath, state);
  await refreshBootstrapBaseline(runtime, state);
  return record;
}

// This durable flag survives a failed balance read even after the fill is logged.
// Recovery never verifies market liquidity to obtain the post-fill baseline.
export async function refreshBootstrapBaseline(runtime: Runtime, state: AgentState): Promise<void> {
  if (!state.bootstrapBaselinePending) return;
  const {config, provider, walletAddress} = runtime;
  const block = await provider.getBlock("latest");
  if (!block || !block.hash) throw new Error("Bootstrap baseline block is unavailable");
  const overrides = {blockTag: block.number};
  const [balance0, balance1, slot] = await Promise.all([
    new Contract(config.token0, ERC20_ABI, provider).balanceOf(walletAddress, overrides) as Promise<bigint>,
    new Contract(config.token1, ERC20_ABI, provider).balanceOf(walletAddress, overrides) as Promise<bigint>,
    new Contract(config.pool, POOL_ABI, provider).slot0(overrides),
  ]);
  const value = balance0 * priceX18FromSqrtPrice(BigInt(slot[0])) / ONE + balance1;
  state.dailyStartValueQuote = value > 0n ? value.toString() : null;
  state.utcDay = utcDay(Date.now());
  state.bootstrapBaselinePending = value <= 0n;
  await saveState(config.statePath, state);
}
