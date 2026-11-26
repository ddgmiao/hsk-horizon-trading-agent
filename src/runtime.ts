import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import type { AgentConfig } from "./config.js";

export interface Runtime {
  config: AgentConfig;
  provider: JsonRpcProvider;
  wallet: Wallet;
  walletAddress: string;
}

export async function createRuntime(config: AgentConfig): Promise<Runtime> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, {staticNetwork: true});
  await assertTestnet(provider, config.chainId);
  const wallet = new Wallet(await readPrivateKey(), provider);
  return {config, provider, wallet, walletAddress: wallet.address};
}

export async function readPrivateKey(): Promise<string> {
  const keyPath = process.env.HSK_AGENT_KEY_FILE;
  if (!keyPath) throw new Error("HSK_AGENT_KEY_FILE must point to a private key file");
  let text: string;
  try {
    const info = await stat(keyPath);
    if ((info.mode & 0o077) !== 0) {
      console.error(`Warning: ${keyPath} is accessible by group or other users (mode ${(info.mode & 0o777).toString(8)}); chmod 600 is recommended for a private key file.`);
    }
    text = (await readFile(keyPath, "utf8")).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Could not read HSK_AGENT_KEY_FILE${code ? ` (${code})` : ""}`);
  }

  let key = text;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {privateKey?: unknown};
      if (typeof parsed.privateKey !== "string") throw new Error();
      key = parsed.privateKey;
    } catch {
      throw new Error("Key JSON must contain a privateKey string");
    }
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error("Key file must contain a raw 32-byte hex key or JSON with a privateKey field");
  return key.startsWith("0x") ? key : `0x${key}`;
}

export async function assertTestnet(provider: JsonRpcProvider, chainId = 133): Promise<void> {
  const chainIdHex = await provider.send("eth_chainId", []) as string;
  const actualChainId = Number(BigInt(chainIdHex));
  if (actualChainId !== 133 || chainId !== 133) {
    throw new Error(`Refusing to operate on chain ID ${actualChainId}; only testnet chain ID 133 is allowed`);
  }
}

export async function loadDecisionLogAddress(): Promise<string> {
  if (process.env.HSK_DECISION_LOG_ADDRESS) return getAddress(process.env.HSK_DECISION_LOG_ADDRESS);
  try {
    const deployment = JSON.parse(await readFile(resolve(".runtime/deployment.json"), "utf8")) as {decisionLog?: string};
    if (deployment.decisionLog) return getAddress(deployment.decisionLog);
  } catch {
    // Deployment metadata is created by the deploy command.
  }
  throw new Error("DecisionLog is not configured; run npm run deploy on chain ID 133 first");
}

export async function persistDeployment(value: Record<string, unknown>): Promise<void> {
  const path = resolve(".runtime/deployment.json");
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
}

export function asContract(address: string, abi: readonly string[], runner: JsonRpcProvider | Wallet): Contract {
  return new Contract(address, abi, runner);
}
