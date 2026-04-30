import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { amountToRawString } from "../../../utils/amount";
import { fetchSwapApproval } from "../../../services/acrossSwapApproval";
import type { AcrossRoute, Env, Token } from "../../../catalog/types";
import { getRpcUrl } from "../../../evm/rpcs";
import { ensureWalletChain } from "../../../evm/ensureWalletChain";
import { getSafeFeeOverrides, type FeeOverrides } from "../../../evm/feeOverrides";

function optPositiveBigInt(v: unknown): bigint | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (s === "" || s === "0") return undefined;
  const b = BigInt(s);
  return b > 0n ? b : undefined;
}

function findRoute(
  routes: AcrossRoute[],
  originChainId: number,
  destinationChainId: number,
  tokenKey: string
) {
  const isNative = tokenKey === "native";
  const addr = tokenKey.startsWith("erc20:") ? tokenKey.slice("erc20:".length).toLowerCase() : null;

  const r = routes.find((x) => {
    if (x.originChainId !== originChainId) return false;
    if (x.destinationChainId !== destinationChainId) return false;

    if (isNative) return !!x.isNative;
    if (!addr) return false;

    return !x.isNative && x.originToken.toLowerCase() === addr;
  });

  if (!r) throw new Error("No matching route for selected (source, dest, token).");
  return r;
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

function txValue(value: unknown, fallback = 0n): bigint {
  return optPositiveBigInt(value) ?? fallback;
}

function receiptFeeWei(receipt: { gasUsed?: bigint; effectiveGasPrice?: bigint }): string | undefined {
  if (receipt.gasUsed === undefined || receipt.effectiveGasPrice === undefined) return undefined;
  return (receipt.gasUsed * receipt.effectiveGasPrice).toString();
}

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function executeAcrossViaSwapApi(args: {
  env: Env;
  originChainId: number;
  destinationChainId: number;
  tokenKey: string;
  amountHuman: string;
  recipient?: Address;
  routes: AcrossRoute[];
  tokens: Token[];
  expectedAccount?: Address;
}) {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("MetaMask not found");

  const walletClient = createWalletClient({
    transport: custom(eth),
  });

  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account connected");
  if (args.expectedAccount && account.toLowerCase() !== args.expectedAccount.toLowerCase()) {
    throw new Error(`Across must be submitted from ${args.expectedAccount}, where Snowbridge delivered the L1 funds.`);
  }

  await ensureWalletChain(eth, args.originChainId);

  const rpcUrl = getRpcUrl(args.originChainId);
  const publicClient = createPublicClient({
    chain: {
      id: args.originChainId,
      name: `Chain ${args.originChainId}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as any,
    transport: http(rpcUrl),
  });

  const route = findRoute(args.routes, args.originChainId, args.destinationChainId, args.tokenKey);

  const token = args.tokens.find((t) => t.key === args.tokenKey);
  const decimals = token?.decimals ?? 18;

  const amountRaw = amountToRawString(args.amountHuman, decimals);
  if (amountRaw === "0") throw new Error("Amount must be > 0");

  const isNativeTransfer = args.tokenKey === "native";
  const inputToken = isNativeTransfer ? NATIVE_TOKEN_ADDRESS : route.originToken;
  const outputToken = isNativeTransfer ? NATIVE_TOKEN_ADDRESS : route.destinationToken;

  const resp = await fetchSwapApproval({
    env: args.env,
    tradeType: "exactInput",
    amount: amountRaw,
    inputToken,
    outputToken,
    originChainId: args.originChainId,
    destinationChainId: args.destinationChainId,
    depositor: account as Address,
    recipient: args.recipient,
    slippage: "auto",
  });

  const approvalTx = isNativeTransfer ? null : (resp.approvalTx ?? null);
  const swapTx = resp.swapTx ?? null;

  if (!swapTx?.to || !swapTx?.data) {
    throw new Error("Across /swap/approval did not return swapTx");
  }

  let approvalHash: Hex | null = null;
  let approvalGasFeeWei: string | undefined;
  if (approvalTx?.to && approvalTx?.data) {
    const approvalFeeOverrides = await getSafeFeeOverrides(publicClient);
    const approvalReq: any = {
      chain: null,
      account: account as Address,
      to: approvalTx.to,
      data: approvalTx.data,
      value: txValue(approvalTx.value),
      gas: optPositiveBigInt(approvalTx.gas),
    };
    applyFeeOverrides(approvalReq, approvalFeeOverrides);

    approvalHash = await walletClient.sendTransaction(approvalReq);

    const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    approvalGasFeeWei = receiptFeeWei(approvalReceipt);
  }

  const swapFeeOverrides = await getSafeFeeOverrides(publicClient);
  const swapReq: any = {
    chain: null,
    account: account as Address,
    to: swapTx.to,
    data: swapTx.data,
    value: txValue(swapTx.value, isNativeTransfer ? BigInt(amountRaw) : 0n),
    gas: optPositiveBigInt(swapTx.gas),
  };
  applyFeeOverrides(swapReq, swapFeeOverrides);

  const swapHash = await walletClient.sendTransaction(swapReq);

  const sourceConfirmationStartedAt = performance.now();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  const sourceConfirmationMs = Math.round(performance.now() - sourceConfirmationStartedAt);

  return {
    account: account as Address,
    approvalTxSent: !!approvalTx,
    approvalTxHash: approvalHash,
    approvalGasFeeWei,
    inputAmountRaw: amountRaw,
    swapTxHash: swapHash,
    swapReceiptStatus: receipt.status, // "success" | "reverted"
    sourceConfirmationMs,
    swapGasFeeWei: receiptFeeWei(receipt),
    expectedOutputAmount: resp.expectedOutputAmount,
    minOutputAmount: resp.minOutputAmount,
    expectedFillTimeSec: resp.expectedFillTime,
    quoteId: resp.id,
  };
}
