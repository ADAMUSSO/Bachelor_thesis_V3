import type { Env } from "../catalog/types";
import type { Address, Hex } from "viem";

const BASE: Record<Env, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

export type AcrossTx = {
  chainId: number;
  to: Address;
  data: Hex;
  value?: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

export type SwapApprovalResponse = {
  approvalTx?: AcrossTx | null;
  swapTx?: AcrossTx | null;
  // API vracia aj ďalšie polia (allowanceState, balanceState, atď.) – zatiaľ nepotrebujeme
};

export async function fetchSwapApproval(params: {
  env: Env;
  tradeType: "exactInput";
  amount: string; // raw (decimal string)
  inputToken: string;
  outputToken: string;
  originChainId: number;
  destinationChainId: number;
  depositor: `0x${string}`;
  recipient?: `0x${string}`;
  slippage?: "auto" | string;
}): Promise<SwapApprovalResponse> {
  const url = new URL(`${BASE[params.env]}/swap/approval`);

  url.searchParams.set("tradeType", params.tradeType);
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("inputToken", params.inputToken);
  url.searchParams.set("outputToken", params.outputToken);
  url.searchParams.set("originChainId", String(params.originChainId));
  url.searchParams.set("destinationChainId", String(params.destinationChainId));
  url.searchParams.set("depositor", params.depositor);
  if (params.recipient) url.searchParams.set("recipient", params.recipient);
  url.searchParams.set("slippage", params.slippage ?? "auto");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Across /swap/approval failed (${res.status}) ${await res.text().catch(() => "")}`);
  return (await res.json()) as SwapApprovalResponse;
}
