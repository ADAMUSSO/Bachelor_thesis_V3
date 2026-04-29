import {
  getSnowbridgeConfig,
  isSnowbridgeDestination,
  resolveSnowbridgeTokenForTransfer,
  supportsSnowbridgeSourceDestination,
  supportsSnowbridgeSource,
  supportsSnowbridgeDestination,
} from "../../catalog/snowbridgeCatalog";
import type { TransferIntent, TransferPlan, TransferPlanContext } from "./types";

export function buildTransferPlan(intent: TransferIntent, context: TransferPlanContext = {}): TransferPlan {
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
  const sourceIsAssetHub = isSnowbridgeDestination(intent.originChainId);

  if (sourceIsAssetHub) {
    const config = getSnowbridgeConfig(intent.env, intent.originChainId);
    if (!supportsSnowbridgeSource({
      env: intent.env,
      destinationChainId: config.l1ChainId,
      tokenKey: intent.tokenKey,
      bridgeEnv: config.bridgeEnv,
    })) {
      throw new Error(
        `Snowbridge from ${config.destinationName} does not support this token on ${intent.env}.`
      );
    }

    if (!supportsSnowbridgeSourceDestination({
      env: intent.env,
      destinationChainId: intent.destinationChainId,
      tokenKey: intent.tokenKey,
      bridgeEnv: config.bridgeEnv,
      routes: context.routes,
    })) {
      throw new Error(`Asset Hub -> L2 needs an Across route from L1 for this token/destination.`);
    }

    if (intent.destinationChainId === config.l1ChainId) {
      return {
        steps: [
          {
            kind: "snowbridgeReverse",
            requiredWallet: "substrate",
            originParaId: config.assetHubParaId,
            destinationChainId: config.l1ChainId,
            bridgeEnv: config.bridgeEnv,
            tokenKey: intent.tokenKey,
            amountSource: "input",
            recipientMode: "final",
          },
        ],
      };
    }

    return {
      steps: [
        {
          kind: "snowbridgeReverse",
          requiredWallet: "substrate",
          originParaId: config.assetHubParaId,
          destinationChainId: config.l1ChainId,
          bridgeEnv: config.bridgeEnv,
          tokenKey: intent.tokenKey,
          amountSource: "input",
          recipientMode: "depositor",
        },
        {
          kind: "across",
          requiredWallet: "evm",
          originChainId: config.l1ChainId,
          destinationChainId: intent.destinationChainId,
          tokenKey: intent.tokenKey,
          recipientMode: "final",
        },
      ],
    };
  }

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
      destinationChainId: intent.destinationChainId,
      tokenKey: intent.tokenKey,
      routes: context.routes,
    })
  ) {
    const config = getSnowbridgeConfig(intent.env, intent.destinationChainId);
    throw new Error(
      `Snowbridge to ${config.destinationName} does not support this token/route on ${intent.env}.`
    );
  }

  const config = getSnowbridgeConfig(intent.env, intent.destinationChainId);
  const snowbridgeTokenKey = resolveSnowbridgeTokenForTransfer({
    env: intent.env,
    originChainId: intent.originChainId,
    destinationChainId: intent.destinationChainId,
    tokenKey: intent.tokenKey,
    routes: context.routes,
  });

  if (!snowbridgeTokenKey) {
    throw new Error(`Snowbridge to ${config.destinationName} does not support this token/route on ${intent.env}.`);
  }

  if (intent.originChainId === config.l1ChainId) {
    return {
      steps: [
        {
          kind: "snowbridge",
          requiredWallet: "evm",
          originChainId: config.l1ChainId,
          destinationParaId: config.assetHubParaId,
          bridgeEnv: config.bridgeEnv,
          tokenKey: snowbridgeTokenKey,
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
        bridgeEnv: config.bridgeEnv,
        tokenKey: snowbridgeTokenKey,
        amountSource: "acrossMinOutput",
      },
    ],
  };
}
