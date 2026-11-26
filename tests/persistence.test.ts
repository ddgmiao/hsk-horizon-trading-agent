import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, saveState, type AgentState } from "../src/persistence.js";

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
    const state = await loadState(join(dir, "state.json"), NOW);
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
      lastTradeAtMs: NOW - 60000,
      utcDay: "2026-11-26",
      dailyStartValueQuote: "12345",
      bootstrapComplete: true,
    };
    await saveState(path, saved);
    assert.deepEqual(await loadState(path, NOW), saved);
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

test("throws on a corrupt state file instead of silently resetting risk baselines", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "state.json");
    await writeFile(path, "{\"lastTradeAtMs\": 12", "utf8");
    await assert.rejects(loadState(path, NOW), /not valid JSON/);
  });
});

test("drops a previous day's loss baseline but keeps the last trade timestamp", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "state.json");
    await saveState(path, {
      lastTradeAtMs: NOW - 3600000,
      utcDay: "2026-11-25",
      dailyStartValueQuote: "999",
      bootstrapComplete: true,
    });
    const state = await loadState(path, NOW);
    assert.equal(state.dailyStartValueQuote, null);
    assert.equal(state.lastTradeAtMs, NOW - 3600000);
    assert.equal(state.bootstrapComplete, true);
  });
});
