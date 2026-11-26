import { Contract, Transaction, getBytes, keccak256, type TransactionRequest } from "ethers";
import { assertTestnet, type Runtime } from "./runtime.js";

// HashKey chain 133 charges L1 data and operator fees in addition to execution gas.
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const FEE_ABI = [
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
];

export class ReserveError extends Error {}

export async function submitWithReserve(runtime: Runtime, request: TransactionRequest, beforeBroadcast?: (hash: string, signed: string) => Promise<void>) {
  const tx = await runtime.wallet.populateTransaction(request);
  const signed = await runtime.wallet.signTransaction(tx);
  return broadcastWithReserve(runtime, signed, beforeBroadcast);
}

export async function broadcastWithReserve(runtime: Runtime, signed: string, beforeBroadcast?: (hash: string, signed: string) => Promise<void>) {
  const {config, provider, walletAddress} = runtime;
  await assertTestnet(provider, config.chainId);
  const tx = Transaction.from(signed);
  const feePerGas = tx.maxFeePerGas ?? tx.gasPrice;
  if (tx.gasLimit == null || feePerGas == null) throw new Error("Missing gas limit or fee cap for reserve check");
  const oracle = new Contract(GAS_PRICE_ORACLE, FEE_ABI, provider);
  const [balance, dataFee, operatorFee] = await Promise.all([
    provider.getBalance(walletAddress, "pending"),
    oracle.getL1FeeUpperBound(getBytes(tx.unsignedSerialized).length) as Promise<bigint>,
    oracle.getOperatorFee(tx.gasLimit) as Promise<bigint>,
  ]);
  const fees = BigInt(tx.gasLimit) * BigInt(feePerGas) + dataFee + operatorFee;
  const required = BigInt(tx.value ?? 0) + fees + config.hskGasReserve;
  if (balance < required) {
    throw new ReserveError(`Native HSK balance ${balance} wei is below ${required} wei required for value, fees and the gas reserve`);
  }
  // Persist the hash of these exact bytes before the first ambiguous network operation.
  if (beforeBroadcast) await beforeBroadcast(keccak256(signed), signed);
  return provider.broadcastTransaction(signed);
}
