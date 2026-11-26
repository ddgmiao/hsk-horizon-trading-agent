import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Linux flock belongs to the open file description shared with the child.
// The utility acquires it on fd 3 and exits; OUR fd keeps it locked through work.
// Closing our fd (also automatic on process death) releases it. No expiring
// lease or stale PID deletion is needed. Never unlink the file: that splits locks.
export async function withAgentLock<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  const dir = dirname(resolve(statePath));
  await mkdir(dir, {recursive: true});
  const handle = await open(join(dir, ".agent.lock"), "a", 0o600);
  try {
    await new Promise<void>((resolveLock, reject) => {
      const child = spawn("flock", ["--exclusive", "3"], {stdio: ["ignore", "ignore", "pipe", handle.fd]});
      let stderr = "";
      child.stderr!.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolveLock() : reject(new Error(`Agent lock failed (${code}): ${stderr}`)));
    });
    return await work();
  } finally {
    await handle.close();
  }
}
