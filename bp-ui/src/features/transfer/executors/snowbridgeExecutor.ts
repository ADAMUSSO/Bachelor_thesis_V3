import { BrowserProvider, type TransactionRequest } from "ethers";
import { assetsV2, Context, toPolkadotSnowbridgeV2 } from "@snowbridge/api";
import { bridgeInfoFor } from "@snowbridge/registry";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, type Address, type Hex } from "viem";
import type { Env } from "../../../catalog/types";
import { getSnowbridgeConfig, type SnowbridgeBridgeEnv } from "../../../catalog/snowbridgeCatalog";
import { amountToRawString } from "../../../utils/amount";
import { getRpcUrl } from "../../../evm/rpcs";
import { ensureWalletChain } from "../../../evm/ensureWalletChain";
import { getSafeFeeOverrides, type FeeOverrides } from "../../../evm/feeOverrides";

type BigNumberishLike = bigint | number | string | { toString(): string } | null | undefined;
type ProgressStatus = "running" | "success";

const ERC20_ABI = [
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
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "ok", type: "bool" }],
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

function tokenAddressFromKey(tokenKey: string): Address {
  if (tokenKey === "native") return assetsV2.ETHER_TOKEN_ADDRESS as Address;

  const value = tokenKey.startsWith("erc20:") ? tokenKey.slice("erc20:".length) : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error("Invalid Snowbridge token.");
  }

  return value.toLowerCase() as Address;
}

function resolveBridgeAsset(args: {
  registry: any;
  tokenKey: string;
}): { address: Address; symbol: string; decimals: number; isNative: boolean } {
  const address = tokenAddressFromKey(args.tokenKey);
  const normalized = address.toLowerCase();
  const asset =
    args.registry?.ethereumChains?.[`ethereum_${args.registry.ethChainId}`]?.assets?.[normalized] ??
    args.registry?.parachains?.[`polkadot_${args.registry.assetHubParaId}`]?.assets?.[normalized];

  if (!asset) throw new Error("Snowbridge registry does not support the selected token.");

  return {
    address,
    symbol: asset.symbol || (args.tokenKey === "native" ? "ETH" : "Token"),
    decimals: Number(asset.decimals ?? 18),
    isNative: args.tokenKey === "native",
  };
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

function isKnownPaseoDryRunOnly(args: {
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

  const messages = Array.isArray(args.validation.logs)
    ? args.validation.logs
        .map((entry) => (typeof entry?.message === "string" ? entry.message : ""))
        .filter(Boolean)
    : [];

  const hasOnlyDryRunErrors =
    messages.length > 0 &&
    messages.every(
      (message) =>
        message === "Dry run on Asset Hub failed." ||
        message.includes("dry running of XCM") ||
        message.includes("Transaction success cannot be confirmed.")
    );

  const assetHubDetail = normalizeDetail(args.validation.data?.assetHubDryRunError);
  const parachainDetail = normalizeDetail(args.validation.data?.destinationParachainDryRunError);

  return (
    hasOnlyDryRunErrors &&
    assetHubDetail?.includes("UntrustedReserveLocation") === true &&
    parachainDetail?.includes("UntrustedReserveLocation") !== true
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

function receiptFeeWei(receipt: { gasUsed?: bigint; effectiveGasPrice?: bigint }): string | undefined {
  if (receipt.gasUsed === undefined || receipt.effectiveGasPrice === undefined) return undefined;
  return (receipt.gasUsed * receipt.effectiveGasPrice).toString();
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
  const sourceConfirmationStartedAt = performance.now();
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash });
  const sourceConfirmationMs = Math.round(performance.now() - sourceConfirmationStartedAt);

  return { hash, receipt, sourceConfirmationMs, gasFeeWei: receiptFeeWei(receipt) };
}

export async function executeSnowbridgeToAssetHub(args: {
  env: Env;
  recipientSubstrate: string;
  tokenKey: string;
  bridgeEnv?: SnowbridgeBridgeEnv;
  tokenDecimals?: number;
  amountHuman?: string;
  amountRaw?: string;
  onProgress?: (event: SnowbridgeProgressEvent) => void;
}) {
  const config = getSnowbridgeConfig(args.env, args.bridgeEnv);

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

  const { registry, environment } = bridgeInfoFor(config.bridgeEnv);
  const bridgeAsset = resolveBridgeAsset({
    registry,
    tokenKey: args.tokenKey,
  });

  const amountRaw = args.amountRaw ?? amountToRawString(args.amountHuman ?? "", args.tokenDecimals ?? bridgeAsset.decimals);
  const amountWei = BigInt(amountRaw);
  if (amountWei <= 0n) throw new Error("Amount must be > 0 for Snowbridge transfer.");

  const context = new Context(environment);

  try {
    context.setEthProvider(config.l1ChainId, new BrowserProvider(eth));

    const transferImpl = toPolkadotSnowbridgeV2.createTransferImplementation(
      config.assetHubParaId,
      registry,
      bridgeAsset.address
    );
    const fee: any = await transferImpl.getDeliveryFee(context, registry, bridgeAsset.address, config.assetHubParaId);

    emitProgress(args.onProgress, {
      stage: "prepare",
      status: "running",
      detail: `Checking ${bridgeAsset.symbol} balance and Snowbridge delivery fee...`,
    });

    const ethBalance = await publicClient.getBalance({ address: account });

    if (bridgeAsset.isNative) {
      if (ethBalance < amountWei + fee.totalFeeInWei) {
        throw new Error(
          `Insufficient ETH to send ${bridgeAsset.symbol} and pay the Snowbridge delivery fee. Required at least ${(amountWei + fee.totalFeeInWei).toString()} wei before gas.`
        );
      }
    } else {
      if (ethBalance < fee.totalFeeInWei) {
        throw new Error(
          `Insufficient ETH to pay the Snowbridge delivery fee. Required at least ${fee.totalFeeInWei.toString()} wei before gas.`
        );
      }

      const tokenBalance = (await publicClient.readContract({
        address: bridgeAsset.address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;

      if (tokenBalance < amountWei) {
        throw new Error(
          `Insufficient ${bridgeAsset.symbol} balance. Required ${amountWei.toString()} raw units.`
        );
      }
    }

    emitProgress(args.onProgress, {
      stage: "prepare",
      status: "success",
      detail: `Using ${bridgeAsset.symbol} for Snowbridge.`,
    });

    let approvalTxHash: Hex | undefined;
    let approvalGasFeeWei: string | undefined;
    if (!bridgeAsset.isNative) {
      const gatewayAddress = txAddress(registry.gatewayAddress);
      const allowance = (await publicClient.readContract({
        address: bridgeAsset.address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, gatewayAddress],
      })) as bigint;

      if (allowance < amountWei) {
        emitProgress(args.onProgress, {
          stage: "approve",
          status: "running",
          detail: `Approving ${bridgeAsset.symbol} for the Snowbridge gateway...`,
        });

        const approvalTx = {
          to: bridgeAsset.address,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [gatewayAddress, amountWei],
          }),
          value: 0n,
        } as TransactionRequest;

        const { hash, receipt, gasFeeWei } = await sendPreparedTransaction({
          walletClient,
          publicClient,
          account,
          tx: approvalTx,
        });

        approvalTxHash = hash;
        approvalGasFeeWei = gasFeeWei;
        if (receipt.status !== "success") {
          throw new Error(`${bridgeAsset.symbol} approval transaction reverted.`);
        }

        emitProgress(args.onProgress, {
          stage: "approve",
          status: "success",
          hash,
          detail: `${bridgeAsset.symbol} approval confirmed.`,
        });
      } else {
        emitProgress(args.onProgress, {
          stage: "approve",
          status: "success",
          detail: `Existing ${bridgeAsset.symbol} allowance is sufficient.`,
        });
      }
    }

    const transfer: any = await transferImpl.createTransfer(
      context,
      registry,
      config.assetHubParaId,
      account,
      args.recipientSubstrate.trim(),
      bridgeAsset.address,
      amountWei,
      fee
    );

    emitProgress(args.onProgress, {
      stage: "bridge",
      status: "running",
      detail: `Validating Snowbridge transfer with ${bridgeAsset.symbol} on Asset Hub...`,
    });

    const validation: any = await transferImpl.validateTransfer(context, transfer);
    if (!validation.success) {
      console.error("Snowbridge validation result:", validation);
      if (!isKnownPaseoDryRunOnly({ env: args.env, validation })) {
        throw new Error(validationError(validation));
      }
      emitProgress(args.onProgress, {
        stage: "bridge",
        status: "running",
        detail:
          "Paseo Asset Hub dry run returned a known UntrustedReserveLocation false-negative. Submitting Snowbridge transfer anyway.",
      });
    }

    const tx = transfer.tx as unknown as TransactionRequest;
    emitProgress(args.onProgress, {
      stage: "bridge",
      status: "running",
      detail: `Submitting Snowbridge transfer with ${bridgeAsset.symbol}...`,
    });

    const { hash, receipt, sourceConfirmationMs, gasFeeWei } = await sendPreparedTransaction({
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
      sourceConfirmationMs,
      bridgeGasFeeWei: gasFeeWei,
      destinationName: config.destinationName,
      bridgeAssetAddress: bridgeAsset.address,
      bridgeAssetSymbol: bridgeAsset.symbol,
      approvalTxHash,
      approvalGasFeeWei,
    };
  } finally {
    await context.destroyContext();
  }
}
