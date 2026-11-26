import { auditDecisionLog, bootstrapOnce, deployDecisionLog, discoverCandidates, observe, preflight, runAgent } from "./agent.js";

const command = process.argv[2] || "help";

try {
  let output: unknown;
  switch (command) {
    case "discover":
      output = await discoverCandidates();
      break;
    case "preflight":
      output = await preflight();
      break;
    case "observe":
      output = await observe();
      break;
    case "bootstrap":
      output = await bootstrapOnce();
      break;
    case "deploy":
      output = await deployDecisionLog();
      break;
    case "audit":
      output = await auditDecisionLog();
      break;
    case "run":
      await runAgent();
      break;
    default:
      output = {commands: ["discover", "preflight", "observe", "deploy", "bootstrap", "run", "audit"]};
      process.exitCode = 1;
  }
  if (output !== undefined) console.log(JSON.stringify(output, bigintReplacer, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
