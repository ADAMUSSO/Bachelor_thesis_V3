import { BrowserProvider, type TransactionRequest } from "ethers";
import { Context, toPolkadotSnowbridgeV2, toPolkadotV2 } from "@snowbridge/api";
import { bridgeInfoFor } from "@snowbridge/registry";
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import type { Env } from "../../../catalog/types";
import { getSnowbridgeConfig } from "../../../catalog/snowbridgeCatalog";
import { amountToRawString } from "../../../utils/amount";
import { getRpcUrl } from "../../../evm/rpcs";
import { ensureWalletChain } from "../../../evm/ensureWalletChain";
import { getSafeFeeOverrides, type FeeOverrides } from "../../../evm/feeOverrides";

type BigNumberishLike = bigint | number | string | { toString(): string } | null | undefined;
type ProgressStatus = "running" | "success";

const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
] as const;

export type SnowbridgeProgressEvent = {
  stage: "prepare" | "approve" | "bridge";
  status: ProgressStatus;
  hash?: Hex;
  detail?: string;
};

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

function resolveSnowbridgeWrappedEthAddress(registry: any): Address {
  const chainAssets = registry?.ethereumChains?.[`ethereum_${registry.ethChainId}`]?.assets;
  if (!chainAssets || typeof chainAssets !== "object") {
    throw new Error("Snowbridge registry is missing the Ethereum asset catalog.");
  }

  for (const [address, asset] of Object.entries<any>(chainAssets)) {
    if (typeof address === "string" && address.startsWith("0x") && asset?.symbol === "WETH") {
      return address as Address;
    }
  }

  throw new Error("Snowbridge registry does not expose Wrapped Ether for this environment.");
}

function emitProgress(
  listener: ((event: SnowbridgeProgressEvent) => void) | undefined,
  event: SnowbridgeProgressEvent
) {
  listener?.(event);
}

function normalizeDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const json = JSON.stringify(
      value,
      (_key, nestedValue) => (typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue),
      2
    );
    return json && json !== "{}" && json !== "[]" ? json : null;
  } catch {
    return String(value);
  }
}

function detailContains(value: unknown, pattern: string): boolean {
  const normalized = normalizeDetail(value);
  return normalized ? normalized.includes(pattern) : false;
}

function shouldBypassKnownPaseoDryRunFailure(args: {
  env: Env;
  validation: {
    logs?: Array<{ message?: unknown }>;
    data?: {
      assetHubDryRunError?: unknown;
      destinationParachainDryRunError?: unknown;
    };
  };
}): boolean {
  if (args.env !== "testnet") return false;

  const logs = Array.isArray(args.validation.logs) ? args.validation.logs : [];
  const messages = logs
    .map((entry) => (typeof entry?.message === "string" ? entry.message : ""))
    .filter(Boolean);

  const hasOnlyDryRunMessages =
    messages.length > 0 &&
    messages.every(
      (message) =>
        message === "Dry run on Asset Hub failed." ||
        message.includes("dry running of XCM") ||
        message.includes("Transaction success cannot be confirmed.")
    );

  if (!hasOnlyDryRunMessages) return false;

  return (
    detailContains(args.validation.data?.assetHubDryRunError, "UntrustedReserveLocation") &&
    !detailContains(args.validation.data?.destinationParachainDryRunError, "UntrustedReserveLocation")
  );
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
    .map(normalizeDetail)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);

  const lines = ["Snowbridge validation failed."];

  if (messages.length > 0) {
    lines.push("Validation logs:");
    for (const message of messages) {
      lines.push(`- ${message}`);
    }
  }

  const extraDetails = details.filter((detail) => !messages.includes(detail));
  if (extraDetails.length > 0) {
    lines.push("Dry run details:");
    for (const detail of extraDetails) {
      lines.push(detail);
    }
  } else {
    lines.push("No structured dry run detail was returned. Check the browser console for the raw Asset Hub dry run payload.");
  }

  return lines.join("\n");
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

async function sendPreparedTransaction(args: {
  walletClient: any;
  publicClient: any;
  account: Address;
  tx: TransactionRequest;
}) {
  const feeOverrides = await getSafeFeeOverrides(args.publicClient);
  const txReq: any = {
    chain: null,
    account: args.account,
    to: txAddress(args.tx.to),
    data: txData(args.tx.data),
    value: toBigIntSafe(args.tx.value) ?? 0n,
    gas: toBigIntSafe(args.tx.gasLimit),
  };
  applyFeeOverrides(txReq, feeOverrides);

  const hash = await args.walletClient.sendTransaction(txReq);
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash });

  return { hash, receipt };
}

export async function executeSnowbridgeToAssetHub(args: {
  env: Env;
  recipientSubstrate: string;
  amountHuman?: string;
  amountRaw?: string;
  onProgress?: (event: SnowbridgeProgressEvent) => void;
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

    const bridgeAssetAddress = resolveSnowbridgeWrappedEthAddress(registry);
    const bridgeAssetSymbol = "WETH";
    const useLegacyTestnetAssetHubFlow = args.env === "testnet";
    const transferImpl = useLegacyTestnetAssetHubFlow
      ? null
      : toPolkadotSnowbridgeV2.createTransferImplementation(
          config.assetHubParaId,
          registry,
          bridgeAssetAddress
        );
    const fee: any = useLegacyTestnetAssetHubFlow
      ? await toPolkadotV2.getDeliveryFee(context, registry, bridgeAssetAddress, config.assetHubParaId)
      : await transferImpl!.getDeliveryFee(context, registry, bridgeAssetAddress, config.assetHubParaId);

    emitProgress(args.onProgress, {
      stage: "prepare",
      status: "running",
      detail: `Checking ${bridgeAssetSymbol} balance for Snowbridge...`,
    });

    const [ethBalance, wrappedBalance, gatewayAllowance] = await Promise.all([
      publicClient.getBalance({ address: account }),
      publicClient.readContract({
        address: bridgeAssetAddress,
        abi: ERC20_READ_ABI,
        functionName: "balanceOf",
        args: [account],
      }),
      publicClient.readContract({
        address: bridgeAssetAddress,
        abi: ERC20_READ_ABI,
        functionName: "allowance",
        args: [account, txAddress(registry.gatewayAddress)],
      }),
    ]);

    const wrapAmountWei = wrappedBalance >= amountWei ? 0n : amountWei - wrappedBalance;

    if (ethBalance < wrapAmountWei + fee.totalFeeInWei) {
      throw new Error(
        `Insufficient ETH to prepare ${bridgeAssetSymbol} and pay the Snowbridge delivery fee. Required at least ${(wrapAmountWei + fee.totalFeeInWei).toString()} wei before gas.`
      );
    }

    let wrapTxHash: Hex | undefined;
    if (wrapAmountWei > 0n) {
      emitProgress(args.onProgress, {
        stage: "prepare",
        status: "running",
        detail: `Wrapping ETH to ${bridgeAssetSymbol} for Snowbridge...`,
      });

      const wrapTx = (await toPolkadotV2.depositWeth(
        account,
        bridgeAssetAddress,
        wrapAmountWei
      )) as unknown as TransactionRequest;
      const { hash, receipt } = await sendPreparedTransaction({
        walletClient,
        publicClient,
        account,
        tx: wrapTx,
      });

      wrapTxHash = hash;
      if (receipt.status !== "success") {
        throw new Error(`${bridgeAssetSymbol} wrap transaction reverted.`);
      }

      emitProgress(args.onProgress, {
        stage: "prepare",
        status: "success",
        hash,
        detail: `Wrapped ETH to ${bridgeAssetSymbol}.`,
      });
    } else {
      emitProgress(args.onProgress, {
        stage: "prepare",
        status: "success",
        detail: `Using existing ${bridgeAssetSymbol} balance.`,
      });
    }

    let approvalTxHash: Hex | undefined;
    if (gatewayAllowance < amountWei) {
      emitProgress(args.onProgress, {
        stage: "approve",
        status: "running",
        detail: `Approving ${bridgeAssetSymbol} for the Snowbridge gateway...`,
      });

      const approvalTx = (await toPolkadotV2.approveTokenSpend(
        context,
        account,
        bridgeAssetAddress,
        amountWei
      )) as unknown as TransactionRequest;
      const { hash, receipt } = await sendPreparedTransaction({
        walletClient,
        publicClient,
        account,
        tx: approvalTx,
      });

      approvalTxHash = hash;
      if (receipt.status !== "success") {
        throw new Error(`${bridgeAssetSymbol} approval transaction reverted.`);
      }

      emitProgress(args.onProgress, {
        stage: "approve",
        status: "success",
        hash,
        detail: `${bridgeAssetSymbol} approval confirmed.`,
      });
    } else {
      emitProgress(args.onProgress, {
        stage: "approve",
        status: "success",
        detail: `Existing ${bridgeAssetSymbol} allowance is sufficient.`,
      });
    }

    const transfer: any = useLegacyTestnetAssetHubFlow
      ? await toPolkadotV2.createTransfer(
          registry,
          account,
          args.recipientSubstrate.trim(),
          bridgeAssetAddress,
          config.assetHubParaId,
          amountWei,
          fee
        )
      : await transferImpl!.createTransfer(
          context,
          registry,
          config.assetHubParaId,
          account,
          args.recipientSubstrate.trim(),
          bridgeAssetAddress,
          amountWei,
          fee
        );

    emitProgress(args.onProgress, {
      stage: "bridge",
      status: "running",
      detail: `Validating Snowbridge transfer with ${bridgeAssetSymbol} on Asset Hub...`,
    });

    const validation: any = useLegacyTestnetAssetHubFlow
      ? await toPolkadotV2.validateTransfer(context, transfer)
      : await transferImpl!.validateTransfer(context, transfer);
    if (!validation.success) {
      console.error("Snowbridge validation result:", validation);
      if (useLegacyTestnetAssetHubFlow && shouldBypassKnownPaseoDryRunFailure({ env: args.env, validation })) {
        emitProgress(args.onProgress, {
          stage: "bridge",
          status: "running",
          detail:
            "Paseo dry run returned a known false-negative (UntrustedReserveLocation). Submitting the legacy Snowbridge transaction anyway.",
        });
      } else {
        throw new Error(validationError(validation));
      }
    }

    const tx = transfer.tx as unknown as TransactionRequest;
    emitProgress(args.onProgress, {
      stage: "bridge",
      status: "running",
      detail: `Submitting Snowbridge transfer with ${bridgeAssetSymbol}...`,
    });

    const { hash, receipt } = await sendPreparedTransaction({
      walletClient,
      publicClient,
      account,
      tx,
    });

    return {
      txHash: hash,
      status: receipt.status,
      amountRaw,
      deliveryFeeWei: fee.totalFeeInWei.toString(),
      executionFeeWei: (validation.data.feeInfo?.executionFee ?? 0n).toString(),
      destinationName: config.destinationName,
      bridgeAssetAddress,
      bridgeAssetSymbol,
      wrapTxHash,
      approvalTxHash,
    };
  } finally {
    await context.destroyContext();
  }
}
