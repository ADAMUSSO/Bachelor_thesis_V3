import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { amountToRawString } from "../../../utils/amount";
import { fetchSwapApproval } from "../../../services/acrossSwapApproval";
import type { AcrossRoute, Env, Token } from "../../../catalog/types";
import { getRpcUrl } from "../../../evm/rpcs";

function findRoute(
  routes: AcrossRoute[],
  originChainId: number,
  destinationChainId: number,
  tokenKey: string
) {
  const isNative = tokenKey === "native";
  const addr = tokenKey.startsWith("erc20:")
    ? tokenKey.slice("erc20:".length).toLowerCase()
    : null;

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

export async function executeAcrossViaSwapApi(args: {
  env: Env;
  originChainId: number;
  destinationChainId: number;
  tokenKey: string;
  amountHuman: string;
  recipient: Address;
  routes: AcrossRoute[];
  tokens: Token[];
}) {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("MetaMask not found");

  // MetaMask signer
  const walletClient = createWalletClient({
    transport: custom(eth),
  });

  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account connected");

  await walletClient.switchChain({ id: args.originChainId });

  // Public client cez RPC pre confirmations
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

  // token addresses from route (works for native too)
  const inputToken = route.originToken;
  const outputToken = route.destinationToken;

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

  const approvalTx = resp.approvalTx ?? null;
  const swapTx = resp.swapTx ?? null;

  if (!swapTx?.to || !swapTx?.data) {
    throw new Error("Across /swap/approval did not return swapTx");
  }

  // 1) approve (ak existuje)
  let approvalHash: Hex | null = null;
  if (approvalTx?.to && approvalTx?.data) {
    approvalHash = await walletClient.sendTransaction({
      chain: null,
      account: account as Address,
      to: approvalTx.to,
      data: approvalTx.data,
      value: approvalTx.value ? BigInt(approvalTx.value) : 0n,
      gas: approvalTx.gas ? BigInt(approvalTx.gas) : undefined,
      maxFeePerGas: approvalTx.maxFeePerGas ? BigInt(approvalTx.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: approvalTx.maxPriorityFeePerGas
        ? BigInt(approvalTx.maxPriorityFeePerGas)
        : undefined,
    });

    // ✅ confirmation
    await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  }

  // 2) swap (bridge)
  const swapHash = await walletClient.sendTransaction({
    chain: null,
    account: account as Address,
    to: swapTx.to,
    data: swapTx.data,
    value: swapTx.value
      ? BigInt(swapTx.value)
      : args.tokenKey === "native"
      ? BigInt(amountRaw)
      : 0n,
    gas: swapTx.gas ? BigInt(swapTx.gas) : undefined,
    maxFeePerGas: swapTx.maxFeePerGas ? BigInt(swapTx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: swapTx.maxPriorityFeePerGas
      ? BigInt(swapTx.maxPriorityFeePerGas)
      : undefined,
  });

  // ✅ confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });

  return {
    approvalTxSent: !!approvalTx,
    approvalTxHash: approvalHash,
    swapTxHash: swapHash,
    swapReceiptStatus: receipt.status, // "success" | "reverted"
  };
}
