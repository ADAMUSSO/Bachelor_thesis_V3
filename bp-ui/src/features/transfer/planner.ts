import { PASEO_ASSETHUB_PARA_ID, SEPOLIA_CHAIN_ID, supportsSnowbridgeDestination } from "../../catalog/snowbridgeCatalog";
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

  const destinationIsPaseoAssetHub = intent.destinationChainId === PASEO_ASSETHUB_PARA_ID;

  if (!destinationIsPaseoAssetHub) {
    return {
      steps: [
        {
          kind: "across",
          requiredWallet: "evm",
          originChainId: intent.originChainId,
          destinationChainId: intent.destinationChainId,
          tokenKey: intent.tokenKey,
          recipientMode: "final",
        },
      ],
    };
  }

  if (
    !supportsSnowbridgeDestination({
      env: intent.env,
      originChainId: intent.originChainId,
      tokenKey: intent.tokenKey,
    })
  ) {
    throw new Error(
      "Snowbridge to Paseo Asset Hub is available only on testnet for native ETH from Sepolia or supported L2 testnets."
    );
  }

  if (intent.originChainId === SEPOLIA_CHAIN_ID) {
    return {
      steps: [
        {
          kind: "snowbridge",
          requiredWallet: "evm",
          originChainId: SEPOLIA_CHAIN_ID,
          destinationParaId: PASEO_ASSETHUB_PARA_ID,
          tokenKey: "native",
          amountSource: "input",
        },
      ],
    };
  }

  return {
    steps: [
      {
        kind: "across",
        requiredWallet: "evm",
        originChainId: intent.originChainId,
        destinationChainId: SEPOLIA_CHAIN_ID,
        tokenKey: intent.tokenKey,
        recipientMode: "depositor",
      },
      {
        kind: "snowbridge",
        requiredWallet: "evm",
        originChainId: SEPOLIA_CHAIN_ID,
        destinationParaId: PASEO_ASSETHUB_PARA_ID,
        tokenKey: "native",
        amountSource: "acrossMinOutput",
      },
    ],
  };
}
