import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress, isAddress, isHexString } from "ethers";
import type { DecisionRecord } from "./agent.js";

export interface PendingSwap {
  tokenIn: string;
  tokenOut: string;
  pool: string;
  record: DecisionRecord;
  registryCall?: {
    args: [string, string, string, string, string, string, string, string, string];
    signedTransaction?: string;
  };
}

export interface AgentState {
  wallet: string;
  lastTradeAtMs: number | null;
  utcDay: string;
  dailyStartValueQuote: string | null;
  bootstrapComplete: boolean;
  pendingSwap: PendingSwap | null;
  bootstrapBaselinePending?: boolean;
}

export function utcDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uint(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function tokenAmount(value: unknown): boolean {
  return typeof value === "string" && /^\d+(\.\d{1,18})?$/.test(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && utcDay(ms) === value;
}

function validExecution(value: unknown): boolean {
  if (!object(value) || typeof value.status !== "string") return false;
  const statuses = ["swap_submitted", "success", "swap_success_bounds_violation", "swap_success_registry_failed", "swap_reverted"];
  const knownAmount = (amount: unknown) => tokenAmount(amount) || (amount === null && value.status === "swap_success_bounds_violation");
  return statuses.includes(value.status) && isHexString(value.swapTxHash, 32) && isAddress(value.decisionLogAddress)
    && [value.approvalTxHash, value.decisionLogTxHash].every(hash => hash === null || isHexString(hash, 32))
    && tokenAmount(value.quoteOut) && tokenAmount(value.minimumOut) && knownAmount(value.amountIn) && knownAmount(value.amountOut)
    && uint(value.priceX96) && (value.error === undefined || typeof value.error === "string");
}

function validPending(value: unknown, wallet: string): value is PendingSwap {
  if (!object(value) || ![value.tokenIn, value.tokenOut, value.pool].every(isAddress) || !object(value.record)) return false;
  const {record} = value;
  if (value.registryCall !== undefined) {
    const call = value.registryCall;
    if (!object(call) || !Array.isArray(call.args) || call.args.length !== 9
      || !(call.signedTransaction === undefined || isHexString(call.signedTransaction))) return false;
    const {args} = call;
    if (![0, 7, 8].every(i => isHexString(args[i], 32)) || ![1, 3, 4, 5, 6].every(i => uint(args[i]))
      || typeof args[2] !== "string" || !/^-?\d+$/.test(args[2])) return false;
  }
  const {plan, signals, execution, addresses, balances, prices, constraints} = record;
  return record.chainId === 133 && isAddress(record.wallet) && getAddress(record.wallet) === wallet
    && typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)) && timestamp(record.blockNumber)
    && object(addresses) && [addresses.factory, addresses.router, addresses.quoter, addresses.pool, addresses.token0, addresses.token1].every(isAddress)
    && object(balances) && [balances.token0, balances.token1, balances.totalValueInToken1].every(tokenAmount)
    && object(prices) && uint(prices.sqrtPriceX96) && uint(prices.bootstrapSqrtPriceX96)
    && tokenAmount(prices.token1PerToken0) && tokenAmount(prices.token1PerWhsk)
    && object(plan) && (plan.kind === "REBALANCE" || plan.kind === "BOOTSTRAP") && (plan.action === "BUY_TOKEN1" || plan.action === "SELL_TOKEN1")
    && tokenAmount(plan.amountIn) && uint(plan.amountInRaw) && typeof plan.reason === "string"
    && object(signals) && [signals.targetToken1Bps, signals.currentToken1WeightBps, signals.deviationBps].every(Number.isSafeInteger)
    && Array.isArray(constraints) && constraints.every(c => object(c) && typeof c.name === "string" && typeof c.passed === "boolean" && typeof c.detail === "string")
    && validExecution(execution);
}

export async function loadState(path: string, signer: string, nowMs = Date.now()): Promise<AgentState> {
  const wallet = getAddress(signer);
  const day = utcDay(nowMs);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {wallet, lastTradeAtMs: null, utcDay: day, dailyStartValueQuote: null, bootstrapComplete: false, pendingSwap: null};
    }
    throw error;
  }
  let state: unknown;
  try {
    state = JSON.parse(contents);
  } catch {
    throw new Error(`Agent state file ${path} is not valid JSON; refusing to trade`);
  }
  if (!object(state) || !isAddress(state.wallet) || !validDay(state.utcDay) || typeof state.bootstrapComplete !== "boolean"
    || !(state.lastTradeAtMs === null || timestamp(state.lastTradeAtMs))
    || !(state.dailyStartValueQuote === null || (uint(state.dailyStartValueQuote) && BigInt(state.dailyStartValueQuote) > 0n))
    || !(state.bootstrapBaselinePending === undefined || typeof state.bootstrapBaselinePending === "boolean")
    || !(state.pendingSwap === null || validPending(state.pendingSwap, wallet))) {
    throw new Error(`Agent state file ${path} has invalid or missing fields; refusing to trade`);
  }
  if (getAddress(state.wallet) !== wallet) throw new Error(`Agent state belongs to ${state.wallet}, signer is ${wallet}; refusing to trade`);
  const pendingRecord = state.pendingSwap?.record;
  if (pendingRecord && pendingRecord.execution.status !== "swap_submitted"
      && pendingRecord.execution.status !== "swap_reverted" && state.lastTradeAtMs === null) {
    throw new Error(`Agent state file ${path} has a confirmed fill without a cooldown; refusing to trade`);
  }
  return {
    wallet, utcDay: day, lastTradeAtMs: state.lastTradeAtMs,
    dailyStartValueQuote: state.utcDay === day ? state.dailyStartValueQuote : null,
    bootstrapComplete: state.bootstrapComplete, pendingSwap: state.pendingSwap,
    ...(state.bootstrapBaselinePending === undefined ? {} : {bootstrapBaselinePending: state.bootstrapBaselinePending}),
  };
}

export async function saveState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600, flag: "wx", flush: true});
    await rename(tmpPath, path);
  } finally {
    await rm(tmpPath, {force: true});
  }
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const ledger = await readLedger(path);
  if (ledger.corruptOffset !== null) await truncate(path, ledger.corruptOffset);
  await appendFile(path, `${ledger.needsNewline ? "\n" : ""}${JSON.stringify(value, bigintReplacer)}\n`, {mode: 0o600, flush: true});
}

export async function readLedger(path: string) {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {records: [] as DecisionRecord[], corruptOffset: null, needsNewline: false};
    throw error;
  }
  const lines = contents.trimEnd().split("\n");
  const records: DecisionRecord[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim()) {
      try {
        const row = JSON.parse(line);
        if (!object(row)) throw new Error("Ledger row must be an object");
        records.push(row as DecisionRecord);
      } catch (error) {
        if (i !== lines.length - 1) throw new Error(`Corrupt non-final ledger line ${i + 1} in ${path}`, {cause: error});
        console.warn(`Warning: skipping corrupt final ledger line ${i + 1} in ${path}; damaged tail will be removed before appending`);
        return {records, corruptOffset: offset, needsNewline: false};
      }
    }
    offset += Buffer.byteLength(line + "\n");
  }
  return {records, corruptOffset: null, needsNewline: contents.length > 0 && !contents.endsWith("\n")};
}

export function isFill(record: DecisionRecord): boolean {
  return !!record.execution?.swapTxHash && ["success", "swap_success_bounds_violation", "swap_success_registry_failed"].includes(record.execution.status);
}

// Cross-check every bound/migrated state against durable fills for this signer.
export async function restoreLedgerCooldown(path: string, state: AgentState): Promise<void> {
  for (const row of (await readLedger(path)).records) {
    if (row.wallet?.toLowerCase() === state.wallet.toLowerCase() && isFill(row)) {
      if (row.plan?.kind === "BOOTSTRAP") state.bootstrapComplete = true;
      const time = Date.parse(row.fillAt ?? row.timestamp);
      if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid fill time in ledger; refusing to trade");
      state.lastTradeAtMs = Math.max(state.lastTradeAtMs ?? 0, time);
    }
  }
}

// A restart can fall between appending the final row and clearing pendingSwap.
export async function findSwapRecord(path: string, wallet: string, hash: string): Promise<DecisionRecord | undefined> {
  return (await readLedger(path)).records.reverse().find(record =>
    record.wallet?.toLowerCase() === wallet.toLowerCase() && record.execution?.swapTxHash === hash);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
