import { BrowserProvider, type TransactionRequest } from "ethers";
import { assetsV2, Context, toPolkadotV2 } from "@snowbridge/api";
import { bridgeInfoFor } from "@snowbridge/registry";
import { createPublicClient, createWalletClient, custom, http, type Address } from "viem";
import type { Env } from "../../../catalog/types";
import { amountToRawString } from "../../../utils/amount";
import { getRpcUrl } from "../../../evm/rpcs";
import { PASEO_ASSETHUB_PARA_ID, SEPOLIA_CHAIN_ID } from "../../../catalog/snowbridgeCatalog";
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

function validationError(logs: unknown): string {
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

  return messages.length ? `Snowbridge validation failed: ${messages.join(" | ")}` : "Snowbridge validation failed.";
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

export async function executeSnowbridgeToPaseo(args: {
  env: Env;
  recipientSubstrate: string;
  amountHuman?: string;
  amountRaw?: string;
}) {
  if (args.env !== "testnet") {
    throw new Error("Snowbridge to Paseo Asset Hub is enabled only on testnet.");
  }

  const eth = (window as any).ethereum;
  if (!eth) throw new Error("MetaMask not found");

  const walletClient = createWalletClient({
    transport: custom(eth),
  });

  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account connected");

  await ensureWalletChain(eth, SEPOLIA_CHAIN_ID);

  const rpcUrl = getRpcUrl(SEPOLIA_CHAIN_ID);
  const publicClient = createPublicClient({
    chain: {
      id: SEPOLIA_CHAIN_ID,
      name: "Ethereum Sepolia",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as any,
    transport: http(rpcUrl),
  });

  const amountRaw =
    args.amountRaw ?? amountToRawString(args.amountHuman ?? "", 18);

  const amountWei = BigInt(amountRaw);
  if (amountWei <= 0n) throw new Error("Amount must be > 0 for Snowbridge transfer.");

  const snowbridgeEnv = String((import.meta as any).env?.VITE_SNOWBRIDGE_ENV ?? "paseo_sepolia");
  const { registry, environment } = bridgeInfoFor(snowbridgeEnv as any);
  const context = new Context(environment);

  try {
    context.setEthProvider(SEPOLIA_CHAIN_ID, new BrowserProvider(eth));

    const fee = await toPolkadotV2.getDeliveryFee(
      context,
      registry,
      assetsV2.ETHER_TOKEN_ADDRESS,
      PASEO_ASSETHUB_PARA_ID
    );

    const transfer = await toPolkadotV2.createTransfer(
      registry,
      account,
      args.recipientSubstrate.trim(),
      assetsV2.ETHER_TOKEN_ADDRESS,
      PASEO_ASSETHUB_PARA_ID,
      amountWei,
      fee
    );

    const validation = await toPolkadotV2.validateTransfer(context, transfer);
    if (!validation.success) {
      throw new Error(validationError(validation.logs));
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
      status: receipt.status, // "success" | "reverted"
      amountRaw,
      deliveryFeeWei: fee.totalFeeInWei.toString(),
      executionFeeWei: (validation.data.feeInfo?.executionFee ?? 0n).toString(),
    };
  } finally {
    await context.destroyContext();
  }
}
