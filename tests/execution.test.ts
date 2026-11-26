import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Interface, Transaction, Wallet, getBytes, keccak256, parseUnits, type TransactionRequest } from "ethers";
import { DECISION_LOG_ABI, ERC20_ABI, FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, ROUTER_ABI, WHSK_ABI } from "../src/abi.js";
import { runAgent, runCycle, type DecisionRecord } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { loadState, readLedger, saveState, type AgentState } from "../src/persistence.js";
import type { Runtime } from "../src/runtime.js";
import { reconcilePendingSwap } from "../src/settlement.js";
import { ONE, Q96 } from "../src/strategy.js";

// Public test fixture key; no filesystem key or RPC transport is used.
const fixtureSigner = new Wallet("0x" + "11".repeat(32));
const walletAddress = fixtureSigner.address;
const registry = "0x0000000000000000000000000000000000000002";
const other = "0x0000000000000000000000000000000000000003";
const fee = 21000n * 2n + 170n + 7n;
const abi = new Interface([...ERC20_ABI, ...POOL_ABI, ...QUOTER_V2_ABI, ...FACTORY_ABI, ...ROUTER_ABI, ...DECISION_LOG_ABI, ...WHSK_ABI,
  "function getL1FeeUpperBound(uint256) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"]);

async function simulatedWallet(t: TestContext, bootstrap = false) {
  const dir = await mkdtemp(join(tmpdir(), "hsk-cycle-"));
  const oldRegistry = process.env.HSK_DECISION_LOG_ADDRESS;
  process.env.HSK_DECISION_LOG_ADDRESS = registry;
  t.after(async () => {
    if (oldRegistry === undefined) delete process.env.HSK_DECISION_LOG_ADDRESS;
    else process.env.HSK_DECISION_LOG_ADDRESS = oldRegistry;
    await rm(dir, {recursive: true, force: true});
  });
  const config = {...loadConfig(), logPath: join(dir, "ledger"), statePath: join(dir, "state")};
  const balances = new Map([[config.token1, bootstrap ? 0n : ONE], [config.token0, 0n], [config.whsk, config.bootstrapHsk]]);
  const state = () => loadState(config.statePath, walletAddress);
  const rows = async (): Promise<DecisionRecord[]> => (await readFile(config.logPath, "utf8")).trim().split("\n").map(s => JSON.parse(s));
  const chain = {
    native: config.hskGasReserve + ONE, allowance: ONE, inputChange: 0n, outputChange: 0n, executionQuote: 0n,
    balanceFailure: false, snapshotFailure: false, unavailableSwap: false, registryTimeout: false, revertSwap: false,
    registryBalanceFailure: false,
    extraWalletTransfer: 0n, omitTransfers: false, omitSwapEvent: false,
    registryBeforeBroadcastFailure: false, receiptLookups: 0, zeroLiquidity: false,
    blockTimestamp: Math.floor(Date.now() / 1000),
  };
  const attempts: string[] = [];
  const registryAmounts: bigint[][] = [];
  const savedAtRegistry: AgentState[] = [];
  const unsignedSizes: number[] = [];
  const broadcastBytes: string[] = [];
  const receiptWaits: (number | undefined)[] = [];
  const prepared = new Map<string, TransactionRequest>();
  const receipts = new Map<string, {hash: string; from: string; to: string; status: number; logs: ReturnType<typeof event>[]}>();
  let quoteCalls = 0;

  function event(emitter: string, name: string, args: unknown[]) {
    return {address: emitter, ...abi.encodeEventLog(abi.getEvent(name)!, args)};
  }

  async function call(tx: TransactionRequest) {
    const addr = String(tx.to);
    const {name, args} = abi.parseTransaction({data: tx.data!})!;
    let result: unknown[];
    switch (name) {
      case "slot0":
        if (chain.snapshotFailure && attempts.includes("record")) throw new Error("injected post-registry snapshot failure");
        result = [Q96, 0, 0, 1, 1, 0, true]; break;
      case "liquidity": result = [chain.zeroLiquidity ? 0n : ONE]; break;
      case "token0": result = [addr === config.pool ? config.token0 : config.token1]; break;
      case "token1": result = [addr === config.pool ? config.token1 : config.whsk]; break;
      case "fee": result = [config.poolFee]; break;
      case "getPool": result = [args.includes(config.whsk) ? config.bootstrapPool : config.pool]; break;
      case "quoteExactInputSingle":
        ++quoteCalls;
        result = [quoteCalls === 2 && chain.executionQuote ? chain.executionQuote : args[0].amountIn * 2n, Q96, 0, 21000]; break;
      case "allowance": result = [chain.allowance]; break;
      case "balanceOf":
        if (chain.balanceFailure && attempts.includes("exactInputSingle")) throw new Error("injected post-receipt balance failure");
        result = [balances.get(addr)]; break;
      case "getL1FeeUpperBound": unsignedSizes.push(Number(args[0])); result = [170n]; break;
      case "getOperatorFee": result = [7n]; break;
      default: throw new Error(`Unexpected simulated call ${name}`);
    }
    return abi.encodeFunctionResult(name, result);
  }

  // This runner has no RPC transport; all submissions terminate in this fixture.
  const provider = {
    call,
    send: async (method: string) => { assert.equal(method, "eth_chainId"); return "0x85"; },
    getCode: async () => "0x1234",
    getBlockNumber: async () => 100,
    getBlock: async () => ({timestamp: chain.blockTimestamp}),
    getBalance: async () => {
      if (chain.registryBalanceFailure && attempts.includes("exactInputSingle")) throw new Error("injected native balance failure");
      return chain.native;
    },
    getTransactionReceipt: async (hash: string) => {
      chain.receiptLookups++;
      const receipt = receipts.get(hash);
      return receipt?.to === config.router && chain.unavailableSwap ? null : receipt;
    },
    waitForTransaction: async (hash: string, _confirmations?: number, timeout?: number) => {
      receiptWaits.push(timeout);
      const receipt = receipts.get(hash)!;
      if (!receipt) throw Object.assign(new Error("bounded receipt wait expired"), {code: "TIMEOUT"});
      if (receipt.to === config.router && chain.unavailableSwap) throw new Error("swap receipt unavailable");
      if (receipt.to === registry && chain.registryTimeout) throw new Error("registry receipt timeout");
      return receipt;
    },
    broadcastTransaction: async (bytes: string) => {
      const tx = Transaction.from(bytes);
      const hash = keccak256(bytes);
      const {name, args} = abi.parseTransaction({data: tx.data!})!;
      broadcastBytes.push(bytes);
      if (name === "record" && chain.registryBeforeBroadcastFailure) throw new Error("transport died before registry broadcast");
      // Like an EVM nonce, identical signed bytes can execute only once.
      if (receipts.has(hash)) return {hash, wait: async () => receipts.get(hash)!};
      const receipt = {hash, from: walletAddress, to: String(tx.to), status: 1, blockHash: "0x" + "ab".repeat(32), logs: [] as ReturnType<typeof event>[]};
      attempts.push(name);
      chain.native -= fee + BigInt(tx.value ?? 0n);
      assert(chain.native >= config.hskGasReserve, "simulated submission would breach the native reserve");
      switch (name) {
        case "deposit": balances.set(config.whsk, balances.get(config.whsk)! + BigInt(tx.value!)); break;
        case "approve": chain.allowance = args[1]; break;
        case "exactInputSingle": {
          assert.equal((await state()).pendingSwap!.record.execution.swapTxHash, hash, "hash must be durable before submission");
          if (chain.revertSwap) { receipt.status = 0; break; }
          const {tokenIn, tokenOut, amountIn} = args[0];
          const input = amountIn + chain.inputChange;
          const output = amountIn * 2n + chain.outputChange;
          const pool = tokenIn === config.whsk ? config.bootstrapPool : config.pool;
          const token0In = BigInt(tokenIn) < BigInt(tokenOut);
          if (!chain.omitTransfers) {
            receipt.logs.push(event(tokenIn, "Transfer", [walletAddress, pool, input]), event(tokenOut, "Transfer", [pool, walletAddress, output]));
          }
          if (!chain.omitSwapEvent) {
            receipt.logs.push(event(pool, "Swap", [config.router, walletAddress, token0In ? input : -output, token0In ? -output : input, Q96, ONE, 0]));
          }
          if (chain.extraWalletTransfer) receipt.logs.push(event(tokenOut, "Transfer", [other, walletAddress, chain.extraWalletTransfer]));
          balances.set(tokenIn, balances.get(tokenIn)! - input);
          balances.set(tokenOut, balances.get(tokenOut)! + output + chain.extraWalletTransfer);
          break;
        }
        case "record":
          savedAtRegistry.push(await state());
          registryAmounts.push([args.amountIn, args.amountOut]);
          break;
        default: throw new Error(`Unexpected simulated submission ${name}`);
      }
      receipts.set(hash, receipt);
      return {hash, wait: async () => receipt};
    },
  };
  const wallet = {
    call, provider,
    populateTransaction: async (tx: TransactionRequest) => ({...tx, type: 2, chainId: 133, nonce: prepared.size, gasLimit: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}),
    signTransaction: async (tx: TransactionRequest) => {
      const id = await fixtureSigner.signTransaction(tx);
      prepared.set(id, tx);
      return id;
    },
  };
  const runtime = {provider, wallet, config, walletAddress} as unknown as Runtime;
  return {cycle: () => runCycle(runtime, config.bootstrapPool), runtime, config, balances, chain, attempts, rows, state,
    registryAmounts, savedAtRegistry, unsignedSizes, broadcastBytes, receiptWaits};
}

for (const bootstrap of [true, false]) {
  for (const fault of ["balanceFailure", "snapshotFailure"] as const) {
    test(`${bootstrap ? "bootstrap" : "rebalance"} fill and cooldown survive injected ${fault} and immediate restart`, async t => {
      const h = await simulatedWallet(t, bootstrap);
      const input = bootstrap ? h.config.bootstrapHsk : h.config.maxTradeInput;
      h.chain[fault] = true;
      if (fault === "balanceFailure") h.chain.outputChange = -(input / 10n);
      // A rebalance already has a baseline, so its next snapshot is on the following poll.
      if (!bootstrap) await h.cycle();
      await assert.rejects(h.cycle(), /injected post-/);
      const [row] = await h.rows();
      assert.equal(row.execution.status, fault === "balanceFailure" ? "swap_success_bounds_violation" : "success");
      assert.match(row.execution.swapTxHash!, /^0x[0-9a-f]{64}$/);
      assert.deepEqual(h.registryAmounts, [[input, 2n * input + h.chain.outputChange]]);
      const state = await h.state();
      assert(state.lastTradeAtMs);
      assert.equal(state.bootstrapComplete, true);
      assert.equal(state.pendingSwap, null);
      assert.equal(h.savedAtRegistry[0].lastTradeAtMs, state.lastTradeAtMs);
      h.chain[fault] = false;
      await h.cycle();
      const blocked = (await h.rows())[1];
      assert.equal(blocked.execution.status, "risk_blocked");
      assert.equal(blocked.constraints.find(c => c.name === "min_trade_interval")!.passed, false);
      assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
    });
  }
}

test("an RPC failure pricing the registry fee preserves the mined bounds violation", async t => {
  const h = await simulatedWallet(t);
  h.chain.registryBalanceFailure = true;
  h.chain.inputChange = 1n;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "swap_success_bounds_violation");
  assert.match(row.execution.error!, /outside signed bounds.*injected native balance failure/);
  assert((await h.state()).lastTradeAtMs);
  assert.deepEqual(h.attempts, ["exactInputSingle"]);
});

test("startup waits for the submitted receipt, reconciles once and enforces the cooldown", async t => {
  const h = await simulatedWallet(t);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  const hash = (await h.state()).pendingSwap!.record.execution.swapTxHash;
  await assert.rejects(h.cycle(), /Awaiting swap receipt/);
  assert.deepEqual(h.attempts, ["exactInputSingle"]);
  h.chain.unavailableSwap = false;
  await h.cycle();
  assert.equal((await h.rows())[0].execution.swapTxHash, hash);
  assert((await h.state()).lastTradeAtMs);
  await h.cycle();
  assert.equal((await h.rows())[1].execution.status, "risk_blocked");
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
});

test("a registry timeout and restart after a ledger append duplicate neither registry write nor row", async t => {
  const h = await simulatedWallet(t);
  h.chain.registryTimeout = true;
  await assert.rejects(h.cycle(), /registry receipt timeout/);
  const beforeAppend = await h.state();
  assert(beforeAppend.pendingSwap!.record.execution.decisionLogTxHash);
  assert(beforeAppend.lastTradeAtMs);
  await h.cycle();
  // Crash after append but before the final state rename.
  await saveState(h.config.statePath, beforeAppend);
  await h.cycle();
  assert.equal((await h.rows()).length, 1);
  assert.equal((await h.state()).pendingSwap, null);
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
});

test("a reverted swap clears the journal without recording a fill or cooldown", async t => {
  const h = await simulatedWallet(t);
  h.chain.revertSwap = true;
  await h.cycle();
  assert.equal((await h.rows())[0].execution.status, "swap_reverted");
  assert.equal((await h.state()).lastTradeAtMs, null);
  assert.equal((await h.state()).pendingSwap, null);
  assert.deepEqual(h.attempts, ["exactInputSingle"]);
});

test("registry amounts come from the swap receipt and exclude an unrelated wallet transfer", async t => {
  const h = await simulatedWallet(t);
  h.chain.extraWalletTransfer = ONE;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "success");
  const input = BigInt(row.plan.amountInRaw);
  assert.deepEqual(h.registryAmounts, [[input, input * 2n]]);
  assert.equal(parseUnits(row.execution.amountOut!, 18), input * 2n);
  assert.equal(h.balances.get(h.config.token0), input * 2n + ONE);
});

test("pool Swap logs identify the fill when Transfer logs are absent", async t => {
  const h = await simulatedWallet(t);
  h.chain.omitTransfers = true;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "success");
  const signed = BigInt(row.plan.amountInRaw);
  assert.deepEqual(h.registryAmounts, [[signed, signed * 2n]]);
});

test("a mined receipt with no attributable amounts keeps its evidence and cooldown without publishing invented values", async t => {
  const h = await simulatedWallet(t);
  h.chain.omitTransfers = h.chain.omitSwapEvent = true;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "swap_success_bounds_violation");
  assert(row.execution.swapTxHash);
  assert.equal(row.execution.amountIn, null);
  assert.equal(row.execution.amountOut, null);
  assert.deepEqual(h.registryAmounts, []);
  assert((await h.state()).lastTradeAtMs);
});

for (const difference of [-1n, 1n]) {
  test(`receipt input differing from signed input by ${difference} is recorded as a bounds violation`, async t => {
    const h = await simulatedWallet(t);
    h.chain.inputChange = difference;
    await h.cycle();
    const [row] = await h.rows();
    assert.equal(row.execution.status, "swap_success_bounds_violation");
    const signed = BigInt(row.plan.amountInRaw);
    assert.deepEqual(h.registryAmounts, [[signed + difference, signed * 2n]]);
    assert.match(row.execution.error!, /signedInput=/);
  });
}

test("bootstrap refuses to wrap the reserve margin when fees would cross it", async t => {
  const h = await simulatedWallet(t, true);
  h.balances.set(h.config.whsk, 0n);
  h.chain.native = h.config.hskGasReserve + h.config.bootstrapHsk;
  await h.cycle();
  assert.equal((await h.rows())[0].execution.status, "bootstrap_blocked");
  assert.match((await h.rows())[0].plan.reason, /fees and the gas reserve/);
  assert.deepEqual(h.attempts, []);
});

test("bootstrap checks the position cap again on the execution quote before approval or swap", async t => {
  const h = await simulatedWallet(t, true);
  h.chain.allowance = 0n;
  h.chain.executionQuote = h.config.maxPositionQuote + 1n;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "bootstrap_blocked");
  assert.equal(row.constraints.find(c => c.name === "max_position_size")!.passed, false);
  assert.equal(parseUnits(row.execution.quoteOut, 18), h.chain.executionQuote);
  assert.deepEqual(h.attempts, []);
});

test("receipt bounds preserve the router's rounded-down minimum on a one-wei quote", async t => {
  const h = await simulatedWallet(t, true);
  h.chain.executionQuote = 1n;
  h.chain.outputChange = -(h.config.bootstrapHsk * 2n);
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.minimumOut, "0.0");
  assert.equal(row.execution.amountOut, "0.0");
  assert.equal(row.execution.status, "success");
});

test("rebalance includes execution, L1 data and operator fees before approving or swapping", async t => {
  const h = await simulatedWallet(t);
  h.chain.allowance = 0n;
  h.chain.native = h.config.hskGasReserve + fee - 1n;
  await h.cycle();
  assert.equal((await h.rows())[0].execution.status, "risk_blocked");
  assert.deepEqual(h.attempts, []);
  h.chain.native += 1n;
  await h.cycle();
  assert.deepEqual(h.attempts, ["approve"]);
  assert.equal(h.chain.native, h.config.hskGasReserve);
  assert.equal((await h.rows())[1].execution.status, "risk_blocked");
});

test("registry write also respects the reserve after a mined rebalance", async t => {
  const h = await simulatedWallet(t);
  h.chain.native = h.config.hskGasReserve + fee;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "swap_success_registry_failed");
  assert.match(row.execution.error!, /gas reserve/);
  assert.deepEqual(h.attempts, ["exactInputSingle"]);
  assert((await h.state()).lastTradeAtMs);
});

test("R1 overlapping decision cycles produce exactly one fill, ledger fill and registry write", async t => {
  const h = await simulatedWallet(t);
  await Promise.all([h.cycle(), h.cycle()]);
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
  const rows = await h.rows();
  assert.equal(rows.length, 1);
  assert(rows[0].execution.swapTxHash);
  await h.cycle();
  assert.equal((await h.rows())[1].execution.status, "risk_blocked");
  assert.equal((await h.rows())[1].constraints.find(c => c.name === "min_trade_interval")!.passed, false);
});

test("R1 overlapping recoveries serialize one pending swap into one row and one registry write", async t => {
  const h = await simulatedWallet(t);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  const hash = (await h.state()).pendingSwap!.record.execution.swapTxHash;
  h.chain.unavailableSwap = false;
  await Promise.all([h.cycle(), h.cycle()]);
  assert.equal((await h.rows()).length, 1);
  assert.equal((await h.rows()).filter(r => r.execution.swapTxHash === hash).length, 1);
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
  assert.equal((await h.state()).pendingSwap, null);
});

test("R2 ledger dedup restores recorded cooldown before clearing an older journal", async t => {
  const h = await simulatedWallet(t);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  const old = await h.state();
  assert.equal(old.lastTradeAtMs, null);
  h.chain.unavailableSwap = false;
  await h.cycle();
  const [fill] = await h.rows();
  await saveState(h.config.statePath, old);
  // Exercise the dedup branch directly so ledger cooldown cross-checking at
  // cycle entry cannot mask a regression in journal reconciliation itself.
  await reconcilePendingSwap(h.runtime, old);
  assert.equal((await h.state()).lastTradeAtMs, Date.parse(fill.timestamp));
  assert.equal((await h.state()).pendingSwap, null);
  await h.cycle();
  assert.equal((await h.rows())[1].constraints.find(c => c.name === "min_trade_interval")!.passed, false);
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
});

test("R3 transport dies after durable registry hash but before broadcast; restart retries exact call once", async t => {
  const h = await simulatedWallet(t);
  h.chain.registryBeforeBroadcastFailure = true;
  await assert.rejects(h.cycle(), /transport died before registry broadcast/);
  const pending = (await h.state()).pendingSwap!;
  assert.equal(h.attempts.filter(n => n === "record").length, 0);
  assert.equal(pending.registryCall!.args.length, 9);
  const signed = pending.registryCall!.signedTransaction!;
  assert.equal(keccak256(signed), pending.record.execution.decisionLogTxHash);
  assert.deepEqual(abi.decodeFunctionData("record", Transaction.from(signed).data).map(String), pending.registryCall!.args);
  h.chain.registryBeforeBroadcastFailure = false;
  t.mock.method(h.runtime.wallet, "signTransaction", async () => { throw new Error("Recovery must use the durable signed envelope"); });
  await h.cycle();
  await saveState(h.config.statePath, await h.savedAtRegistry[0]); // replay the pre-append journal too
  await h.cycle();
  assert.equal((await h.rows()).length, 1);
  assert.equal((await h.rows())[0].execution.decisionLogTxHash, keccak256(signed));
  assert.equal(h.broadcastBytes.filter(b => b === signed).length, 2);
  assert(h.receiptWaits.includes(5000), "recovery waits a bounded interval before exact rebroadcast");
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
  assert.equal((await h.state()).pendingSwap, null);
});

test("R4 runAgent recovers receipts before zero-liquidity startup verification", async t => {
  const h = await simulatedWallet(t);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  h.chain.unavailableSwap = false;
  h.chain.zeroLiquidity = true;
  await runAgent(1, h.runtime);
  assert(h.chain.receiptLookups > 0);
  assert.equal((await h.rows())[0].execution.status, "success");
  assert.equal((await h.state()).pendingSwap, null);
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
});

test("R4 truncated final ledger line warns, recovers once and permits subsequent restarts", async t => {
  const h = await simulatedWallet(t);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  const prefix = JSON.stringify({status: "old_observation"}) + "\n";
  await writeFile(h.config.logPath, prefix + '{"timestamp":"torn');
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  h.chain.unavailableSwap = false;
  await h.cycle();
  assert(warnings.some(w => /skipping corrupt final ledger line/.test(w)));
  assert((await readFile(h.config.logPath, "utf8")).startsWith(prefix));
  assert.equal((await h.rows()).filter(r => r.execution?.swapTxHash).length, 1);
  await h.cycle();
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
  await appendFile(h.config.logPath, '{"corrupt":\n{}\n');
  await assert.rejects(readLedger(h.config.logPath), /Corrupt non-final ledger line/);
});

test("R5 recovered bootstrap restores its post-fill baseline and blocks a later daily loss", async t => {
  const h = await simulatedWallet(t, true);
  h.chain.registryTimeout = true;
  await assert.rejects(h.cycle(), /registry receipt timeout/);
  assert.equal((await h.state()).dailyStartValueQuote, null);
  const interrupted = await h.state();
  delete interrupted.bootstrapBaselinePending; // confirmed round-2 journal
  await saveState(h.config.statePath, interrupted);
  h.chain.registryTimeout = false;
  await h.cycle();
  const after = h.balances.get(h.config.token1)!;
  assert.equal((await h.state()).dailyStartValueQuote, String(after));
  assert.equal((await h.state()).bootstrapComplete, true);
  h.balances.set(h.config.token1, after / 2n);
  t.mock.method(Date, "now", () => h.chain.blockTimestamp * 1000 + h.config.minTradeIntervalMs);
  await h.cycle();
  const row = (await h.rows())[1];
  assert.equal(row.execution.status, "risk_blocked");
  assert.equal(row.constraints.find(c => c.name === "daily_loss_halt")!.passed, false);
  assert.equal((await h.state()).dailyStartValueQuote, String(after));
});

test("R5 delayed recovery takes fill timestamp and cooldown from the mined block", async t => {
  const h = await simulatedWallet(t);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  const minedAt = h.chain.blockTimestamp * 1000;
  t.mock.method(Date, "now", () => minedAt + 3600000);
  h.chain.unavailableSwap = false;
  await h.cycle();
  assert.equal(Date.parse((await h.rows())[0].timestamp), minedAt);
  assert.equal((await h.state()).lastTradeAtMs, minedAt);
  const registryCall = h.savedAtRegistry[0].pendingSwap!.registryCall!;
  assert.equal(registryCall.args[1], String(h.chain.blockTimestamp));
});

test("F5 binding stale state for the same owner keeps the later ledger cooldown", async t => {
  const h = await simulatedWallet(t);
  await h.cycle();
  const state = await h.state();
  const recent = state.lastTradeAtMs!;
  for (const lastTradeAtMs of [recent - 3600000, recent + 1000]) {
    await saveState(h.config.statePath, {...state, lastTradeAtMs});
    await h.cycle();
    assert.equal((await h.state()).lastTradeAtMs, Math.max(recent, lastTradeAtMs));
  }
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
});

test("L6 oracle receives unsigned serialized size rather than the signed envelope size", async t => {
  const h = await simulatedWallet(t);
  await h.cycle();
  assert.equal(h.unsignedSizes.length, h.broadcastBytes.length);
  for (const [index, signed] of h.broadcastBytes.entries()) {
    assert.equal(h.unsignedSizes[index], getBytes(Transaction.from(signed).unsignedSerialized).length);
    assert(h.unsignedSizes[index] < getBytes(signed).length);
  }
});
