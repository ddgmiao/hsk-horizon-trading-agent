import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, saveState, type AgentState } from "../src/persistence.js";

const WALLET = "0x3ebc1896581bc0566A21903cC64Ed7e66F62284e";
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hsk-state-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

test("returns a fresh state when the state file does not exist", async () => {
  await withTempDir(async (dir) => {
    const state = await loadState(join(dir, "state.json"), WALLET, NOW);
    assert.equal(state.lastTradeAtMs, null);
    assert.equal(state.dailyStartValueQuote, null);
    assert.equal(state.bootstrapComplete, false);
    assert.equal(state.utcDay, "2026-11-26");
  });
});

test("round-trips state through save and load without leaving a temp file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "state.json");
    const saved: AgentState = {
      wallet: WALLET,
      pendingSwap: null,
      lastTradeAtMs: NOW - 60000,
      utcDay: "2026-11-26",
      dailyStartValueQuote: "12345",
      bootstrapComplete: true,
    };
    await saveState(path, saved);
    assert.deepEqual(await loadState(path, WALLET, NOW), saved);
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

test("throws on a corrupt state file instead of silently resetting risk baselines", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "state.json");
    await writeFile(path, "{\"lastTradeAtMs\": 12", "utf8");
    await assert.rejects(loadState(path, WALLET, NOW), /not valid JSON/);
  });
});

test("drops a previous day's loss baseline but keeps the last trade timestamp", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "state.json");
    await saveState(path, {
      wallet: WALLET,
      pendingSwap: null,
      lastTradeAtMs: NOW - 3600000,
      utcDay: "2026-11-25",
      dailyStartValueQuote: "999",
      bootstrapComplete: true,
    });
    const state = await loadState(path, WALLET, NOW);
    assert.equal(state.dailyStartValueQuote, null);
    assert.equal(state.lastTradeAtMs, NOW - 3600000);
    assert.equal(state.bootstrapComplete, true);
  });
});

const valid = {wallet: WALLET, pendingSwap: null, lastTradeAtMs: NOW, dailyStartValueQuote: "200", utcDay: "2026-11-26", bootstrapComplete: true};

for (const [label, value] of [
  ["empty object", {}], ["array root", []], ["missing risk field", {...valid, lastTradeAtMs: undefined}],
  ["string timestamp", {...valid, lastTradeAtMs: String(NOW)}], ["negative timestamp", {...valid, lastTradeAtMs: -1}],
  ["non-finite baseline", {...valid, dailyStartValueQuote: "Infinity"}], ["negative baseline", {...valid, dailyStartValueQuote: "-2"}],
  ["numeric baseline", {...valid, dailyStartValueQuote: 2}], ["invalid UTC day", {...valid, utcDay: "2026-02-31"}],
  ["zero baseline", {...valid, dailyStartValueQuote: "0"}],
  ["non-boolean bootstrap flag", {...valid, bootstrapComplete: 1}], ["missing wallet identity", {...valid, wallet: undefined}],
  ["incomplete pending swap", {...valid, pendingSwap: {}}], ["missing journal field", {...valid, pendingSwap: undefined}],
] as const) {
  test(`refuses to trade with ${label} in persisted state`, async () => {
    await withTempDir(async dir => {
      const path = join(dir, "state.json");
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(loadState(path, WALLET, NOW), /refusing to trade/);
    });
  });
}

test("binds the state to the signer across restarts", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "state.json");
    const state = await loadState(path, WALLET.toLowerCase(), NOW);
    assert.equal(state.wallet, WALLET);
    await saveState(path, state);
    await assert.rejects(loadState(path, "0x0000000000000000000000000000000000000001", NOW), /signer.*refusing to trade/);
  });
});

test("parallel saves both complete and leave one intact state", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "state.json");
    const states = [valid, {...valid, lastTradeAtMs: NOW - 1, dailyStartValueQuote: "150"}];
    await Promise.all(states.map(s => saveState(path, s)));
    const stored = await loadState(path, WALLET, NOW);
    assert.deepEqual(stored, states.find(s => s.lastTradeAtMs === stored.lastTradeAtMs));
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});
