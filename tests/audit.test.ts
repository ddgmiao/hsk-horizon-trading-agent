import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { JsonRpcProvider, zeroPadValue } from "ethers";
import published from "../deployment/registry.json" with {type: "json"};
import { auditDecisionLog } from "../src/agent.js";
import { loadAuditDeployment } from "../src/runtime.js";

async function cleanCheckout(t: TestContext) {
  const cwd = process.cwd();
  const registry = process.env.HSK_DECISION_LOG_ADDRESS;
  const dir = await mkdtemp(join(tmpdir(), "hsk-audit-"));
  delete process.env.HSK_DECISION_LOG_ADDRESS;
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    if (registry === undefined) delete process.env.HSK_DECISION_LOG_ADDRESS;
    else process.env.HSK_DECISION_LOG_ADDRESS = registry;
    await rm(dir, {recursive: true, force: true});
  });
}

test("clean-checkout audit queries from deployment through head using the indexed agent topic", async t => {
  await cleanCheckout(t);
  const head = 36244512;
  const windows: number[][] = [];
  t.mock.method(JsonRpcProvider.prototype, "send", async (method: string, args: any[]) => {
    switch (method) {
      case "eth_chainId": return "0x85";
      case "eth_getCode": return "0x1234";
      case "eth_blockNumber": return "0x" + head.toString(16);
      case "eth_getLogs": {
        const [filter] = args;
        assert.equal(filter.address.toLowerCase(), published.decisionLog.toLowerCase());
        assert.equal(filter.topics[2].toLowerCase(), zeroPadValue(published.agent, 32).toLowerCase());
        windows.push([Number(filter.fromBlock), Number(filter.toBlock)]);
        return [];
      }
      default: throw new Error(`Unexpected RPC method ${method}`);
    }
  });
  const result = await auditDecisionLog();
  assert.equal(result.fromBlock, 36242135);
  assert.equal(result.agent, published.agent);
  assert.deepEqual(windows, [[36242135, 36243134], [36243135, 36244134], [36244135, head]]);
});

test("audit honors matching local deployment metadata and never borrows another registry's block", async t => {
  await cleanCheckout(t);
  const address = "0x0000000000000000000000000000000000000001";
  await mkdir(".runtime");
  await writeFile(".runtime/deployment.json", JSON.stringify({decisionLog: address, deployedAtBlock: 200}));
  assert.deepEqual(await loadAuditDeployment(), {address, fromBlock: 200, agent: null});
  process.env.HSK_DECISION_LOG_ADDRESS = published.decisionLog;
  assert.equal((await loadAuditDeployment()).fromBlock, 36242135);
  process.env.HSK_DECISION_LOG_ADDRESS = "0x0000000000000000000000000000000000000002";
  await assert.rejects(loadAuditDeployment(), /requires a deployment block/);
});

test("audit rejects local start blocks inconsistent with the published registry", async t => {
  await cleanCheckout(t);
  await mkdir(".runtime");
  for (const deployedAtBlock of [36242628, published.deployedAtBlock - 1]) {
    await writeFile(".runtime/deployment.json", JSON.stringify({decisionLog: published.decisionLog, deployedAtBlock}));
    await assert.rejects(loadAuditDeployment(), /inconsistent with deployment\/registry.json/);
  }
});

test("audit scans another registry without the published wallet topic", async t => {
  await cleanCheckout(t);
  const address = "0x0000000000000000000000000000000000000001";
  await mkdir(".runtime");
  await writeFile(".runtime/deployment.json", JSON.stringify({decisionLog: address, deployedAtBlock: 200}));
  t.mock.method(JsonRpcProvider.prototype, "send", async (method: string, args: any[]) => {
    if (method === "eth_chainId") return "0x85";
    if (method === "eth_getCode") return "0x1234";
    if (method === "eth_blockNumber") return "0xc8";
    assert.equal(method, "eth_getLogs");
    assert.equal(args[0].address.toLowerCase(), address);
    assert.equal(args[0].topics.length, 1);
    return [];
  });
  const result = await auditDecisionLog();
  assert.equal(result.agent, null);
  assert.equal(result.fromBlock, 200);
});
