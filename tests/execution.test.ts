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
import { ONE, Q96, planRebalance } from "../src/strategy.js";

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
    blockTimestamp: Math.floor(Date.now() / 1000), blockNumber: 100,
    sqrtPriceX96: Q96, bootstrapSqrtPriceX96: Q96,
    quoteOverride: null as bigint | null, quoteSequence: [] as bigint[],
    afterApproval: null as (() => void) | null,
    afterQuote: null as (() => void) | null,
  };
  const attempts: string[] = [];
  const reads: {name: string; blockTag: unknown}[] = [];
  const routerMinimums: bigint[] = [];
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
    reads.push({name, blockTag: tx.blockTag});
    let result: unknown[];
    switch (name) {
      case "slot0":
        if (chain.snapshotFailure && attempts.includes("record")) throw new Error("injected post-registry snapshot failure");
        result = [addr === config.pool ? chain.sqrtPriceX96 : chain.bootstrapSqrtPriceX96, 0, 0, 1, 1, 0, true]; break;
      case "liquidity": result = [chain.zeroLiquidity ? 0n : ONE]; break;
      case "token0": result = [addr === config.pool ? config.token0 : config.token1]; break;
      case "token1": result = [addr === config.pool ? config.token1 : config.whsk]; break;
      case "fee": result = [config.poolFee]; break;
      case "getPool": result = [args.includes(config.whsk) ? config.bootstrapPool : config.pool]; break;
      case "quoteExactInputSingle":
        ++quoteCalls;
        result = [chain.quoteSequence.shift() ?? chain.quoteOverride ?? (quoteCalls === 2 && chain.executionQuote ? chain.executionQuote : args[0].amountIn * 2n), Q96, 0, 21000]; chain.afterQuote?.(); break;
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
    getBlockNumber: async () => { throw new Error("Decision block must be fetched before reads"); },
    getBlock: async () => ({number: chain.blockNumber, hash: "0x" + chain.blockNumber.toString(16).padStart(64, "0"), timestamp: chain.blockTimestamp}),
    getBalance: async (_address: string, blockTag: unknown) => {
      reads.push({name: "nativeBalance", blockTag});
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
        case "approve": chain.allowance = args[1]; chain.blockNumber++; chain.afterApproval?.(); break;
        case "exactInputSingle": {
          assert.equal((await state()).pendingSwap!.record.execution.swapTxHash, hash, "hash must be durable before submission");
          if (chain.revertSwap) { receipt.status = 0; break; }
          const {tokenIn, tokenOut, amountIn} = args[0];
          routerMinimums.push(args[0].amountOutMinimum);
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
    registryAmounts, savedAtRegistry, unsignedSizes, broadcastBytes, receiptWaits, reads, routerMinimums};
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

test("receipt bounds ceil a one-wei quote minimum and reject a zero-output bootstrap", async t => {
  const h = await simulatedWallet(t, true);
  h.config.bootstrapHsk = 1n; // The decision spot also rounds to less than one output wei.
  h.chain.executionQuote = 1n;
  h.chain.outputChange = -(h.config.bootstrapHsk * 2n);
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.minimumOut, "0.000000000000000001");
  assert.equal(row.execution.amountOut, "0.0");
  assert.equal(row.execution.status, "swap_success_bounds_violation");
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
  t.mock.method(Date, "now", () => h.chain.blockTimestamp * 1000);
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

test("decision prices, balances, allowance and quote share a block and record effective policy", async t => {
  const h = await simulatedWallet(t);
  h.config.hskGasReserve += ONE / 100n;
  await h.cycle();
  const [row] = await h.rows();
  const decisionReads = h.reads.filter(r => ["slot0", "liquidity", "balanceOf", "allowance", "quoteExactInputSingle"].includes(r.name));
  assert.equal(decisionReads.length, 8);
  assert(decisionReads.every(r => r.blockTag === 100));
  assert(h.reads.some(r => r.name === "nativeBalance" && r.blockTag === 100));
  assert.equal(row.blockNumber, 100);
  assert.equal(row.blockHash, "0x" + (100).toString(16).padStart(64, "0"));
  assert.equal(parseUnits(row.policy.hskGasReserve, 18), h.config.hskGasReserve);
  assert.equal(row.policy.targetToken1Bps, h.config.targetToken1Bps);
  assert.equal(row.policy.rebalanceBandBps, h.config.rebalanceBandBps);
  assert.equal(row.policy.maxSlippageBps, h.config.maxSlippageBps);
  assert(row.observedAt && row.quoteAt && row.fillAt);
});

test("registry keeps observation time through delayed settlement while cooldown uses fill time", async t => {
  const h = await simulatedWallet(t);
  const observedMs = h.chain.blockTimestamp * 1000 - 60000;
  let clock = observedMs;
  h.chain.afterQuote = () => { clock += 1000; };
  t.mock.method(Date, "now", () => clock);
  h.chain.unavailableSwap = true;
  await assert.rejects(h.cycle(), /receipt unavailable/);
  const pending = (await h.state()).pendingSwap!;
  assert.equal(Date.parse(pending.record.observedAt), observedMs);
  clock += 3600000;
  h.chain.unavailableSwap = false;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(Date.parse(row.observedAt), observedMs);
  assert.equal(Date.parse(row.quoteAt!), observedMs + 1000);
  assert.equal(Date.parse(row.fillAt!), h.chain.blockTimestamp * 1000);
  assert.equal(h.savedAtRegistry[0].pendingSwap!.registryCall!.args[1], String(observedMs / 1000));
  const state = await h.state();
  await saveState(h.config.statePath, {...state, lastTradeAtMs: observedMs});
  await h.cycle();
  assert.equal((await h.state()).lastTradeAtMs, h.chain.blockTimestamp * 1000);
});

for (const fault of ["hold", "liquidity", "loss", "quote", "snapshot"] as const) {
  test(`post-approval refresh blocks swap after ${fault} guard changes`, async t => {
    const h = await simulatedWallet(t);
    h.chain.allowance = 0n;
    h.chain.afterApproval = () => {
      if (fault === "hold") { h.balances.set(h.config.token0, ONE / 2n); h.balances.set(h.config.token1, ONE / 2n); }
      if (fault === "liquidity") h.chain.zeroLiquidity = true;
      if (fault === "loss") h.balances.set(h.config.token1, ONE / 2n);
      if (fault === "quote") h.chain.quoteOverride = 1n;
      if (fault === "snapshot") t.mock.method(h.runtime.provider, "getBlock", async () => { throw new Error("injected refresh failure"); });
    };
    await h.cycle();
    const [row] = await h.rows();
    assert.equal(row.execution.status, "risk_blocked");
    assert(row.execution.approvalTxHash);
    assert.equal(row.execution.swapTxHash, null);
    assert.deepEqual(h.attempts, ["approve"]);
    assert.match(row.execution.error!, /Post-approval/);
    if (fault !== "snapshot") {
      assert.equal(row.blockNumber, 101);
      assert.equal(row.approvalRevalidation!.originalBlockNumber, 100);
      assert(h.reads.some(r => r.name === "slot0" && r.blockTag === 101));
    }
  });
}

test("post-approval refresh preserves the original minimum for the same input", async t => {
  const h = await simulatedWallet(t);
  h.chain.allowance = 0n;
  h.chain.quoteSequence = [ONE / 5n, 199n * ONE / 1000n];
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "success");
  assert.equal(parseUnits(row.execution.minimumOut, 18), 198n * ONE / 1000n);
  assert.equal(row.execution.minimumOut, row.approvalRevalidation!.originalMinimumOut);
  assert.deepEqual(h.routerMinimums, [198n * ONE / 1000n]);
  assert.deepEqual(h.attempts, ["approve", "exactInputSingle", "record"]);
  assert.equal(row.blockNumber, 101);
});

test("post-approval refresh rejects a quote below the preserved original minimum", async t => {
  const h = await simulatedWallet(t);
  h.chain.allowance = 0n;
  h.chain.quoteSequence = [ONE / 5n, 197n * ONE / 1000n];
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "risk_blocked");
  assert.match(row.execution.error!, /preserved minimum/);
  assert.deepEqual(h.attempts, ["approve"]);
});

test("gas floor adds approval only when allowance is below the planned amount", async t => {
  const h = await simulatedWallet(t);
  const gap = 42n * ONE / 100000n;
  h.config.rebalanceBandBps = 0;
  h.balances.set(h.config.token0, ONE / 2n - gap);
  h.balances.set(h.config.token1, ONE / 2n + gap);
  // At mark 1 and the fixture's favorable quote, D removed is enough for
  // swap+registry but below swap+registry+approval at the configured multiple.
  h.chain.quoteOverride = gap;
  h.chain.allowance = 0n;
  await h.cycle();
  const [blocked] = await h.rows();
  assert.equal(blocked.constraints.find(c => c.name === "gas_floor")!.passed, false);
  h.chain.allowance = h.config.maxTradeInput;
  await h.cycle();
  assert.equal((await h.rows())[1].constraints.find(c => c.name === "gas_floor")!.passed, true);
});

for (const token of ["token0", "token1"] as const) {
  test(`one wei of ${token} permits initial dust bootstrap`, async t => {
    const h = await simulatedWallet(t, true);
    h.balances.set(h.config[token], 1n);
    await h.cycle();
    const [row] = await h.rows();
    assert.equal(row.plan.kind, "BOOTSTRAP");
    assert.equal(row.execution.status, "success");
    assert.equal(row.bootstrap.dustRuleFired, true);
    assert.equal(parseUnits(row.bootstrap.minimumTradableNotionalQuote, 18), h.config.minTradableNotionalQuote);
    assert.equal((await h.state()).bootstrapComplete, true);
  });
}

test("dust bootstrap includes existing TT1 in the seed position cap", async t => {
  const h = await simulatedWallet(t, true);
  h.balances.set(h.config.token1, 1n);
  h.config.maxPositionQuote = h.config.bootstrapHsk * 2n;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "bootstrap_blocked");
  assert.equal(row.bootstrap.dustRuleFired, true);
  assert.match(row.plan.reason, /maximum position/);
  assert.deepEqual(h.attempts, []);
});

test("dust bootstrap enforces reserve and never reseeds a provisioned wallet", async t => {
  const h = await simulatedWallet(t, true);
  h.balances.set(h.config.token1, 1n);
  h.chain.native = h.config.hskGasReserve - 1n;
  await h.cycle();
  assert.equal((await h.rows())[0].execution.status, "bootstrap_blocked");
  assert.deepEqual(h.attempts, []);
  const state = await h.state();
  await saveState(h.config.statePath, {...state, bootstrapComplete: true});
  h.chain.native += ONE;
  await h.cycle();
  assert.equal((await h.rows())[1].plan.kind, "REBALANCE");
  assert.deepEqual(h.attempts, []);
});

test("spot minimum wins over a weaker execution quote and blocks a quote already below it", async t => {
  const h = await simulatedWallet(t);
  const spot = h.config.maxTradeInput * 997n / 1000n;
  const minimum = (spot * 9900n + 9999n) / 10000n;
  h.chain.quoteOverride = spot - 1n;
  await h.cycle();
  assert.equal(h.routerMinimums[0], minimum);
  assert.equal(parseUnits((await h.rows())[0].execution.minimumOut, 18), minimum);
  // Re-arm only the fixture cooldown to inspect another independent decision.
  const second = await simulatedWallet(t);
  second.chain.quoteOverride = minimum - 1n;
  await second.cycle();
  const [row] = await second.rows();
  assert.equal(row.constraints.find(c => c.name === "spot_quote_floor")!.passed, false);
  assert.deepEqual(second.attempts, []);
});

test("row-9 fee-adjusted spot minimum is tighter and the historical fill clears it", async t => {
  const h = await simulatedWallet(t);
  h.balances.set(h.config.token1, 172180703260754993n);
  h.config.maxTradeInput = 86090351630377497n;
  h.chain.sqrtPriceX96 = 45572482661888092273398720957n;
  h.chain.quoteOverride = 259328888119975221n;
  h.chain.outputChange = h.chain.quoteOverride - 2n * h.config.maxTradeInput;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "success");
  const spot = h.config.maxTradeInput * 997000n * ONE / (1000000n * 330861480906068668n);
  const spotMinimum = (spot * 9900n + 9999n) / 10000n;
  const quoteMinimum = (h.chain.quoteOverride * 9900n + 9999n) / 10000n;
  assert(spotMinimum > quoteMinimum);
  assert.equal(parseUnits(row.execution.minimumOut, 18), spotMinimum);
  assert.equal((spotMinimum + 5n * 10n ** 11n) / 10n ** 12n, 256826n);
  assert(h.chain.quoteOverride >= spotMinimum);
});

test("ordinary quote minimum rounds up by exactly one wei when division has a remainder", async t => {
  const h = await simulatedWallet(t);
  h.chain.quoteOverride = ONE / 5n + 1n;
  await h.cycle();
  assert.equal(h.routerMinimums[0], h.chain.quoteOverride * 9900n / 10000n + 1n);
});

for (const fault of ["direction", "larger_input"] as const) {
  test(`post-approval refresh refuses another approval after ${fault} changes`, async t => {
    const h = await simulatedWallet(t);
    h.chain.allowance = 0n;
    if (fault === "larger_input") h.balances.set(h.config.token1, ONE / 10n);
    h.chain.afterApproval = () => {
      if (fault === "direction") { h.balances.set(h.config.token0, ONE); h.balances.set(h.config.token1, 0n); }
      else h.balances.set(h.config.token1, ONE / 5n);
    };
    await h.cycle();
    const [row] = await h.rows();
    assert.equal(row.execution.status, "risk_blocked");
    assert.match(row.execution.error!, /different input token or another approval/);
    assert.deepEqual(h.attempts, ["approve"]);
  });
}

test("bootstrap revalidates its quote and existing TT1 position after approval", async t => {
  const h = await simulatedWallet(t, true);
  h.balances.set(h.config.token1, 1n);
  h.chain.allowance = 0n;
  h.chain.afterApproval = () => { h.chain.quoteOverride = h.config.maxPositionQuote; };
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "bootstrap_blocked");
  assert.equal(row.constraints.find(c => c.name === "max_position_size")!.passed, false);
  assert.equal(row.bootstrap.dustRuleFired, true);
  assert.equal(row.blockNumber, 101);
  assert.deepEqual(h.attempts, ["approve"]);
});

test("bootstrap history prevents dust reseeding even when persisted provisioning state is stale", async t => {
  const h = await simulatedWallet(t, true);
  await h.cycle();
  h.balances.set(h.config.token1, 1n);
  await saveState(h.config.statePath, {...await h.state(), bootstrapComplete: false});
  await h.cycle();
  assert.equal((await h.rows())[1].plan.kind, "REBALANCE");
  assert.equal((await h.state()).bootstrapComplete, true);
  assert.deepEqual(h.attempts, ["exactInputSingle", "record"]);
});

test("buy uses the fee-adjusted spot mark for its execution minimum", async t => {
  const h = await simulatedWallet(t);
  h.balances.set(h.config.token0, ONE);
  h.balances.set(h.config.token1, 0n);
  h.chain.sqrtPriceX96 = 2n * Q96; // 4 TT1 per TT2.
  const spot = h.config.maxTradeInput * 997n * 4n / 1000n;
  h.chain.quoteOverride = spot;
  h.chain.outputChange = spot - 2n * h.config.maxTradeInput;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.plan.action, "BUY_TOKEN1");
  assert.equal(parseUnits(row.execution.feeAdjustedSpotOut!, 18), spot);
  assert.equal(h.routerMinimums[0], (spot * 9900n + 9999n) / 10000n);
});

test("default whole-path floor still permits a calibrated band-edge rebalance with approval", async t => {
  const h = await simulatedWallet(t);
  const total = 171953n * ONE / 1000000n;
  const gap = 8598n * ONE / 1000000n;
  h.balances.set(h.config.token1, total / 2n + gap);
  h.balances.set(h.config.token0, total - (total / 2n + gap));
  // WHSK is bootstrap token1: sqrt(1 / 17.24617) in Q96.
  h.chain.bootstrapSqrtPriceX96 = 19078017919451293556923157450n;
  h.chain.allowance = 0n;
  const planned = planRebalance({balance0: h.balances.get(h.config.token0)!, balance1: h.balances.get(h.config.token1)!, price1Per0X18: ONE}, h.config);
  h.chain.quoteOverride = planned.amountIn * 997n / 1000n;
  h.chain.outputChange = h.chain.quoteOverride - 2n * planned.amountIn;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "success");
  assert.equal(row.constraints.find(c => c.name === "gas_floor")!.passed, true);
  const expected = h.config.estimatedGasHsk + h.config.estimatedApprovalGasHsk + h.config.estimatedRegistryGasHsk;
  assert.equal(parseUnits(row.approvalRevalidation!.originalExpectedPathCostHsk, 18), expected);
  assert.deepEqual(h.attempts, ["approve", "exactInputSingle", "record"]);
});

test("a one-wei bootstrap quote below the decision spot minimum is blocked before approval", async t => {
  const h = await simulatedWallet(t, true);
  h.chain.executionQuote = 1n;
  h.chain.allowance = 0n;
  await h.cycle();
  const [row] = await h.rows();
  assert.equal(row.execution.status, "bootstrap_blocked");
  assert.equal(row.constraints.find(c => c.name === "spot_quote_floor")!.passed, false);
  assert(parseUnits(row.execution.minimumOut, 18) > 1n);
  assert.deepEqual(h.attempts, []);
});
