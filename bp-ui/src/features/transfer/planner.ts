import type { TransferIntent, TransferPlan } from "./types";

export function buildTransferPlan(intent: TransferIntent): TransferPlan {
  if (!intent.originChainId || !intent.destinationChainId) {
    throw new Error("Missing chains");
  }

  if (!intent.tokenKey) {
    throw new Error("Missing token");
  }

  if (!intent.amount || Number(intent.amount) <= 0) {
    throw new Error("Invalid amount");
  }

  const step = {
    kind: "across" as const,
    requiredWallet: "evm" as const,
    originChainId: intent.originChainId,
    destinationChainId: intent.destinationChainId,
    tokenKey: intent.tokenKey,
  };

  return { steps: [step] };
}
