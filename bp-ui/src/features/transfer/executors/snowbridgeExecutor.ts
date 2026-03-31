import { BrowserProvider, type TransactionRequest } from "ethers";
import { assetsV2, Context, toPolkadotV2 } from "@snowbridge/api";
import { bridgeInfoFor } from "@snowbridge/registry";
import { createPublicClient, createWalletClient, custom, http, type Address } from "viem";
import type { Env } from "../../../catalog/types";
import { getSnowbridgeConfig } from "../../../catalog/snowbridgeCatalog";
import { amountToRawString } from "../../../utils/amount";
import { getRpcUrl } from "../../../evm/rpcs";
import { ensureWalletChain } from "../../../evm/ensureWalletChain";
import { getSafeFeeOverrides, type FeeOverrides } from "../../../evm/feeOverrides";

type BigNumberishLike = bigint | number | string | { toString(): string } | null | undefined;

function toBigIntSafe(value: BigNumberishLike): bigint | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);

  const s = typeof value === "string" ? value.trim() : value.toString().trim();
  if (!s) return undefined;

  return BigInt(s);
}

function txAddress(value: unknown): Address {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error("Invalid Snowbridge transaction target address.");
  }

  return value as Address;
}

function txData(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error("Invalid Snowbridge transaction calldata.");
  }

  return value as `0x${string}`;
}

function validationError(result: {
  logs: unknown;
  data?: {
    assetHubDryRunError?: unknown;
    destinationParachainDryRunError?: unknown;
  };
}): string {
  const { logs, data } = result;
  if (!Array.isArray(logs)) return "Snowbridge validation failed.";

  const messages = logs
    .map((entry) => {
      if (entry && typeof entry === "object" && "message" in entry) {
        const message = (entry as { message?: unknown }).message;
        return typeof message === "string" ? message : "";
      }
      return "";
    })
    .filter(Boolean);

  const details = [data?.assetHubDryRunError, data?.destinationParachainDryRunError]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);

  const parts = [
    ...messages,
    ...details.filter((detail) => !messages.includes(detail)),
  ];

  return parts.length ? `Snowbridge validation failed: ${parts.join(" | ")}` : "Snowbridge validation failed.";
}

function applyFeeOverrides(request: any, feeOverrides: FeeOverrides) {
  if (feeOverrides.gasPrice !== undefined) {
    request.gasPrice = feeOverrides.gasPrice;
    return;
  }

  if (feeOverrides.maxFeePerGas !== undefined) {
    request.maxFeePerGas = feeOverrides.maxFeePerGas;
  }
  if (feeOverrides.maxPriorityFeePerGas !== undefined) {
    request.maxPriorityFeePerGas = feeOverrides.maxPriorityFeePerGas;
  }
}

export async function executeSnowbridgeToAssetHub(args: {
  env: Env;
  recipientSubstrate: string;
  amountHuman?: string;
  amountRaw?: string;
}) {
  const config = getSnowbridgeConfig(args.env);

  const eth = (window as any).ethereum;
  if (!eth) throw new Error("MetaMask not found");

  const walletClient = createWalletClient({
    transport: custom(eth),
  });

  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account connected");

  await ensureWalletChain(eth, config.l1ChainId);

  const rpcUrl = getRpcUrl(config.l1ChainId);
  const publicClient = createPublicClient({
    chain: {
      id: config.l1ChainId,
      name: config.l1ChainId === 1 ? "Ethereum" : "Ethereum Sepolia",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as any,
    transport: http(rpcUrl),
  });

  const amountRaw = args.amountRaw ?? amountToRawString(args.amountHuman ?? "", 18);
  const amountWei = BigInt(amountRaw);
  if (amountWei <= 0n) throw new Error("Amount must be > 0 for Snowbridge transfer.");

  const { registry, environment } = bridgeInfoFor(config.bridgeEnv);
  const context = new Context(environment);

  try {
    context.setEthProvider(config.l1ChainId, new BrowserProvider(eth));

    const fee = await toPolkadotV2.getDeliveryFee(
      context,
      registry,
      assetsV2.ETHER_TOKEN_ADDRESS,
      config.assetHubParaId
    );

    const transfer = await toPolkadotV2.createTransfer(
      registry,
      account,
      args.recipientSubstrate.trim(),
      assetsV2.ETHER_TOKEN_ADDRESS,
      config.assetHubParaId,
      amountWei,
      fee
    );

    const validation = await toPolkadotV2.validateTransfer(context, transfer);
    if (!validation.success) {
      throw new Error(validationError(validation));
    }

    const tx = transfer.tx as unknown as TransactionRequest;
    const feeOverrides = await getSafeFeeOverrides(publicClient);
    const txReq: any = {
      chain: null,
      account,
      to: txAddress(tx.to),
      data: txData(tx.data),
      value: toBigIntSafe(tx.value) ?? 0n,
      gas: toBigIntSafe(tx.gasLimit),
    };
    applyFeeOverrides(txReq, feeOverrides);

    const hash = await walletClient.sendTransaction(txReq);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    return {
      txHash: hash,
      status: receipt.status,
      amountRaw,
      deliveryFeeWei: fee.totalFeeInWei.toString(),
      executionFeeWei: (validation.data.feeInfo?.executionFee ?? 0n).toString(),
      destinationName: config.destinationName,
    };
  } finally {
    await context.destroyContext();
  }
}
