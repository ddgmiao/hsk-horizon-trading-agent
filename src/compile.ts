import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {InterfaceAbi} from "ethers";
import solc from "solc";

export async function compileDecisionLog() {
  const source = await readFile(resolve("contracts/AgentDecisionLog.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: {"AgentDecisionLog.sol": {content: source}},
    settings: {outputSelection: {"*": {"*": ["abi", "evm.bytecode.object"]}}},
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{severity: string; formattedMessage: string}>;
    contracts?: Record<string, Record<string, {abi: InterfaceAbi; evm: {bytecode: {object: string}}}>>;
  };
  const errors = (output.errors || []).filter((item) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
  const artifact = output.contracts?.["AgentDecisionLog.sol"]?.AgentDecisionLog;
  if (!artifact?.evm.bytecode.object) throw new Error("AgentDecisionLog compiler output is empty");
  return {abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`};
}

if (process.argv[1]?.endsWith("compile.ts")) {
  const artifact = await compileDecisionLog();
  console.log(JSON.stringify({contract: "AgentDecisionLog", bytecodeBytes: (artifact.bytecode.length - 2) / 2, compiler: solc.version()}));
}
