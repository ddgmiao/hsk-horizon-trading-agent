import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withAgentLock } from "../src/locking.js";

test("R1 separate processes serialize the same state directory; an abandoned lock file is harmless", {timeout: 10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "hsk-lock-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const counter = join(dir, "counter");
  await writeFile(counter, "0");
  await writeFile(join(dir, ".agent.lock"), "abandoned file from a prior process");
  const worker = `
    import { withAgentLock } from ${JSON.stringify(new URL("../src/locking.ts", import.meta.url).href)};
    import { readFile, writeFile } from 'node:fs/promises';
    await withAgentLock(${JSON.stringify(join(dir, "state"))}, async () => {
      const n = Number(await readFile(${JSON.stringify(counter)}, 'utf8'));
      await new Promise(r => setTimeout(r, 40));
      await writeFile(${JSON.stringify(counter)}, String(n + 1));
    });`;
  const children = Array.from({length: 3}, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker], {stdio: "pipe"}));
  await Promise.all(children.map(async child => {
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
  }));
  assert.equal(await readFile(counter, "utf8"), "3");
});

test("R1 kernel releases the lock when its owning agent is killed", {timeout: 10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "hsk-lock-crash-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, "state");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { withAgentLock } from ${JSON.stringify(new URL("../src/locking.ts", import.meta.url).href)};
    await withAgentLock(${JSON.stringify(path)}, async () => {
      process.stdout.write('acquired');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });`], {stdio: "pipe"});
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  let entered = false;
  await withAgentLock(path, async () => { entered = true; });
  assert(entered);
});
