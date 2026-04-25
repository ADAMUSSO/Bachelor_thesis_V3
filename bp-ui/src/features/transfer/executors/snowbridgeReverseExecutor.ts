import { assetsV2, Context, toEthereumSnowbridgeV2 } from "@snowbridge/api";
import { bridgeInfoFor } from "@snowbridge/registry";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import type { Env } from "../../../catalog/types";
import { getSnowbridgeConfig } from "../../../catalog/snowbridgeCatalog";
import { amountToRawString } from "../../../utils/amount";

type ProgressStatus = "running" | "success";

export type SnowbridgeReverseProgressEvent = {
  stage: "prepare" | "bridge";
  status: ProgressStatus;
  hash?: string;
  detail?: string;
};

function tokenAddressFromKey(tokenKey: string): string {
  if (tokenKey === "native") return assetsV2.ETHER_TOKEN_ADDRESS;

  const value = tokenKey.startsWith("erc20:") ? tokenKey.slice("erc20:".length) : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error("Invalid Snowbridge token.");
  }

  return value.toLowerCase();
}

function normalizeDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);

  try {
    const json = JSON.stringify(value, (_key, nestedValue) => (
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    ), 2);
    return json && json !== "{}" && json !== "[]" ? json : null;
  } catch {
    return String(value);
  }
}

function validationError(result: { logs: unknown; data?: Record<string, unknown> }): string {
  const lines = ["Snowbridge validation failed."];

  if (Array.isArray(result.logs)) {
    const messages = result.logs
      .map((entry) => {
        if (entry && typeof entry === "object" && "message" in entry) {
          const message = (entry as { message?: unknown }).message;
          return typeof message === "string" ? message : "";
        }
        return "";
      })
      .filter(Boolean);

    if (messages.length > 0) {
      lines.push("Validation logs:");
      for (const message of messages) lines.push(`- ${message}`);
    }
  }

  const details = Object.values(result.data ?? {})
    .map(normalizeDetail)
    .filter((value): value is string => !!value);

  if (details.length > 0) {
    lines.push("Dry run details:");
    for (const detail of details) lines.push(detail);
  }

  return lines.join("\n");
}

async function getSubstrateSigner() {
  await cryptoWaitReady();

  const injected = (window as any).injectedWeb3;
  const extensions = injected && typeof injected === "object" ? Object.entries(injected) : [];
  if (extensions.length === 0) throw new Error("Polkadot extension not found.");

  const [, extension] = extensions[0] as [string, any];
  const injector = await extension.enable("BP UI");
  const accounts = await injector.accounts.get();
  const account = accounts[0];

  if (!account?.address) throw new Error("No account in Polkadot extension.");
  if (!injector.signer) throw new Error("Polkadot extension signer is not available.");

  return { address: account.address as string, signer: injector.signer };
}

export async function executeSnowbridgeFromAssetHub(args: {
  env: Env;
  destinationChainId: number;
  recipientEvm: string;
  tokenKey: string;
  tokenDecimals?: number;
  amountHuman: string;
  onProgress?: (event: SnowbridgeReverseProgressEvent) => void;
}) {
  const config = getSnowbridgeConfig(args.env);
  const tokenAddress = tokenAddressFromKey(args.tokenKey);
  const { registry, environment } = bridgeInfoFor(config.bridgeEnv);
  const asset =
    registry.ethereumChains[`ethereum_${registry.ethChainId}`]?.assets[tokenAddress] ??
    registry.parachains[`polkadot_${registry.assetHubParaId}`]?.assets[tokenAddress];

  if (!asset) throw new Error("Snowbridge registry does not support the selected token.");

  const symbol = asset.symbol || (args.tokenKey === "native" ? "ETH" : "Token");
  const decimals = Number(args.tokenDecimals ?? asset.decimals ?? 18);
  const amountRaw = amountToRawString(args.amountHuman, decimals);
  const amount = BigInt(amountRaw);
  if (amount <= 0n) throw new Error("Amount must be > 0 for Snowbridge transfer.");

  args.onProgress?.({
    stage: "prepare",
    status: "running",
    detail: `Connecting Polkadot extension and preparing ${symbol} transfer...`,
  });

  const { address: sourceAddress, signer } = await getSubstrateSigner();
  const context = new Context(environment);

  try {
    if (args.destinationChainId !== config.l1ChainId) {
      throw new Error("Asset Hub source is supported only to L1. Use Across from L1 to L2 after the Snowbridge transfer arrives.");
    }

    const implementation: any = toEthereumSnowbridgeV2.createTransferImplementation(
      config.assetHubParaId,
      registry,
      tokenAddress
    );

    const fee: any = await implementation.getDeliveryFee(
      { sourceParaId: config.assetHubParaId, context },
      registry,
      tokenAddress
    );

    args.onProgress?.({
      stage: "prepare",
      status: "success",
      detail: `Using ${sourceAddress} on ${config.destinationName}.`,
    });

    const transfer: any = await implementation.createTransfer(
      { sourceParaId: config.assetHubParaId, context },
      registry,
      sourceAddress,
      args.recipientEvm.trim(),
      tokenAddress,
      amount,
      fee
    );

    args.onProgress?.({
      stage: "bridge",
      status: "running",
      detail: `Validating Snowbridge ${config.destinationName} -> EVM transfer...`,
    });

    const validation: any = await implementation.validateTransfer(context, transfer);
    if (!validation.success) {
      console.error("Snowbridge reverse validation result:", validation);
      throw new Error(validationError(validation));
    }

    args.onProgress?.({
      stage: "bridge",
      status: "running",
      detail: `Submitting ${symbol} transfer from ${config.destinationName}...`,
    });

    const receipt = await toEthereumSnowbridgeV2.signAndSend(context, transfer, sourceAddress, { signer });

    return {
      txHash: receipt.txHash,
      status: receipt.success ? "success" : "reverted",
      amountRaw,
      deliveryFeeDot: fee.totalFeeInDot?.toString?.() ?? "",
      bridgeAssetAddress: tokenAddress,
      bridgeAssetSymbol: symbol,
      sourceAddress,
      destinationChainId: args.destinationChainId,
    };
  } finally {
    await context.destroyContext();
  }
}
