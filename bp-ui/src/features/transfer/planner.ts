import { getSnowbridgeConfig, isSnowbridgeDestination, supportsSnowbridgeDestination } from "../../catalog/snowbridgeCatalog";
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

  const destinationIsAssetHub = isSnowbridgeDestination(intent.destinationChainId);

  if (!destinationIsAssetHub) {
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
    const config = getSnowbridgeConfig(intent.env);
    throw new Error(
      `Snowbridge to ${config.destinationName} is available only for native ETH from Ethereum or supported L2 chains on ${intent.env}.`
    );
  }

  const config = getSnowbridgeConfig(intent.env);

  if (intent.originChainId === config.l1ChainId) {
    return {
      steps: [
        {
          kind: "snowbridge",
          requiredWallet: "evm",
          originChainId: config.l1ChainId,
          destinationParaId: config.assetHubParaId,
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
        destinationChainId: config.l1ChainId,
        tokenKey: intent.tokenKey,
        recipientMode: "depositor",
      },
      {
        kind: "snowbridge",
        requiredWallet: "evm",
        originChainId: config.l1ChainId,
        destinationParaId: config.assetHubParaId,
        tokenKey: "native",
        amountSource: "acrossMinOutput",
      },
    ],
  };
}
