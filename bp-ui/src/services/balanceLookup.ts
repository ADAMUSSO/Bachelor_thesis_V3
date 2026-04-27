import { ApiPromise, WsProvider } from "@polkadot/api";
import { bridgeInfoFor } from "@snowbridge/registry";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress, type Address } from "viem";
import { getAcrossTokensForChain } from "../catalog/acrossCatalog";
import { getSnowbridgeConfig } from "../catalog/snowbridgeCatalog";
import type { Chain, Env, Token } from "../catalog/types";
import { getRpcUrl } from "../evm/rpcs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type AssetBalance = {
  key: string;
  symbol: string;
  rawAmount: bigint;
  decimals: number;
  displayAmount: string;
  isNative: boolean;
  address?: string;
};

type SubstrateAssetRecord = {
  token?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  assetId?: string;
  location?: any;
  locationOnAH?: any;
};

function formatBalanceDisplay(rawAmount: bigint, decimals: number): string {
  const full = formatUnits(rawAmount, decimals);
  const [whole, fraction = ""] = full.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");

  if (!trimmedFraction) return whole;
  if (whole !== "0") return `${whole}.${trimmedFraction.slice(0, 6)}`;

  const firstSignificant = trimmedFraction.search(/[1-9]/);
  if (firstSignificant === -1) return "0";
  if (firstSignificant >= 6) return "< 0.000001";

  const visibleLength = Math.min(trimmedFraction.length, firstSignificant + 4);
  return `0.${trimmedFraction.slice(0, visibleLength)}`;
}

function sortBalances(a: AssetBalance, b: AssetBalance): number {
  if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
  return a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key);
}

function assetSymbol(symbol?: string, fallbackAddress?: string): string {
  const clean = symbol?.trim();
  if (clean) return clean;
  if (fallbackAddress && isAddress(fallbackAddress)) {
    return `${fallbackAddress.slice(0, 6)}...${fallbackAddress.slice(-4)}`;
  }
  return "UNKNOWN";
}

function isHereLocation(location: any): boolean {
  if (!location) return false;
  if (location.parents !== 1) return false;

  const interior = location.interior;
  if (interior === "Here" || interior === "here") return true;
  if (typeof interior === "object" && interior !== null && "here" in interior) return interior.here === null;

  return false;
}

function erc20Location(ethChainId: number, tokenAddress: string) {
  if (tokenAddress.toLowerCase() === ZERO_ADDRESS) {
    return {
      parents: 2,
      interior: {
        x1: [
          {
            globalConsensus: {
              ethereum: {
                chainId: ethChainId,
              },
            },
          },
        ],
      },
    };
  }

  return {
    parents: 2,
    interior: {
      x2: [
        {
          globalConsensus: {
            ethereum: {
              chainId: ethChainId,
            },
          },
        },
        {
          accountKey20: {
            key: tokenAddress.toLowerCase(),
          },
        },
      ],
    },
  };
}

function getAssetHubBridgeInfo(env: Env, chainId?: number): any {
  return bridgeInfoFor(getSnowbridgeConfig(env, chainId).bridgeEnv);
}

function getAssetHubRpcUrl(config: ReturnType<typeof getSnowbridgeConfig>, bridgeInfo: any): string {
  const env = import.meta.env as any;

  if (config.bridgeEnv === "westend_sepolia") {
    return env.VITE_RPC_ASSET_HUB_WESTEND || "wss://asset-hub-westend-rpc.n.dwellir.com";
  }

  if (config.bridgeEnv === "paseo_sepolia") {
    return env.VITE_RPC_ASSET_HUB_PASEO || bridgeInfo.environment.parachains[String(config.assetHubParaId)];
  }

  return env.VITE_RPC_ASSET_HUB_POLKADOT || bridgeInfo.environment.parachains[String(config.assetHubParaId)];
}

async function readErc20Balance(args: {
  publicClient: ReturnType<typeof createPublicClient>;
  token: Token;
  walletAddress: Address;
}): Promise<AssetBalance | null> {
  const { publicClient, token, walletAddress } = args;

  if (!token.address) return null;

  try {
    const rawAmount = await publicClient.readContract({
      abi: erc20Abi,
      address: token.address as Address,
      functionName: "balanceOf",
      args: [walletAddress],
    });

    if (rawAmount === 0n) return null;

    let decimals = token.decimals;

    try {
      decimals = await publicClient.readContract({
        abi: erc20Abi,
        address: token.address as Address,
        functionName: "decimals",
      });
    } catch {
      // Fall back to catalog decimals when token metadata is unavailable.
    }

    return {
      key: token.key,
      symbol: assetSymbol(token.symbol, token.address),
      address: token.address,
      decimals,
      isNative: token.isNative,
      rawAmount,
      displayAmount: formatBalanceDisplay(rawAmount, decimals),
    };
  } catch {
    return null;
  }
}

async function fetchEvmBalances(args: {
  env: Env;
  chain: Chain;
  walletAddress: string;
}): Promise<AssetBalance[]> {
  const publicClient = createPublicClient({
    transport: http(getRpcUrl(args.chain.chainId)),
  });

  const tokens = await getAcrossTokensForChain(args.env, args.chain.chainId);
  const nativeToken =
    tokens.find((token) => token.isNative) ??
    ({
      key: "native",
      symbol: "Native",
      decimals: 18,
      chainId: args.chain.chainId,
      isNative: true,
    } satisfies Token);

  const [nativeBalance, erc20Balances] = await Promise.all([
    publicClient.getBalance({ address: args.walletAddress as Address }),
    Promise.all(
      tokens
        .filter((token) => !token.isNative)
        .map((token) =>
          readErc20Balance({
            publicClient,
            token,
            walletAddress: args.walletAddress as Address,
          })
        )
    ),
  ]);

  const balances: AssetBalance[] = [];

  if (nativeBalance > 0n) {
    balances.push({
      key: nativeToken.key,
      symbol: assetSymbol(nativeToken.symbol),
      decimals: nativeToken.decimals,
      isNative: true,
      rawAmount: nativeBalance,
      displayAmount: formatBalanceDisplay(nativeBalance, nativeToken.decimals),
    });
  }

  for (const balance of erc20Balances) {
    if (balance) balances.push(balance);
  }

  return balances.sort(sortBalances);
}

async function readSubstrateAssetBalance(args: {
  api: ApiPromise;
  walletAddress: string;
  ethChainId: number;
  tokenAddress: string;
  asset: SubstrateAssetRecord;
}): Promise<AssetBalance | null> {
  const { api, walletAddress, ethChainId, tokenAddress, asset } = args;

  const location = asset.locationOnAH ?? asset.location ?? erc20Location(ethChainId, tokenAddress);
  if (isHereLocation(location)) return null;

  try {
    const accountData =
      asset.assetId != null
        ? ((await api.query.assets.account(asset.assetId, walletAddress)).toPrimitive() as any)
        : ((await api.query.foreignAssets.account(location, walletAddress)).toPrimitive() as any);

    const rawAmount = BigInt(accountData?.balance ?? 0n);
    if (rawAmount === 0n) return null;

    let decimals = Number(asset.decimals ?? 0);
    let symbol = asset.symbol?.trim() ?? "";

    if (!symbol || decimals === 0) {
      try {
        const metadata =
          asset.assetId != null
            ? ((await api.query.assets.metadata(asset.assetId)).toPrimitive() as any)
            : ((await api.query.foreignAssets.metadata(location)).toPrimitive() as any);

        symbol = metadata?.symbol ? String(metadata.symbol).trim() : symbol;
        decimals =
          typeof metadata?.decimals === "number"
            ? metadata.decimals
            : typeof metadata?.decimals === "string"
              ? Number(metadata.decimals)
              : decimals;
      } catch {
        // Keep registry metadata if chain metadata lookup fails.
      }
    }

    if (!Number.isFinite(decimals) || decimals < 0) decimals = 0;

    return {
      key: `substrate:${tokenAddress.toLowerCase()}`,
      symbol: assetSymbol(symbol || asset.name, tokenAddress),
      address: tokenAddress.toLowerCase(),
      decimals,
      isNative: false,
      rawAmount,
      displayAmount: formatBalanceDisplay(rawAmount, decimals),
    };
  } catch {
    return null;
  }
}

async function fetchAssetHubBalances(args: {
  env: Env;
  chain: Chain;
  walletAddress: string;
}): Promise<AssetBalance[]> {
  const config = getSnowbridgeConfig(args.env, args.chain.chainId);
  const bridgeInfo = getAssetHubBridgeInfo(args.env, args.chain.chainId);
  const assetHubChain = config.destinationChain;
  const parachainKey = `polkadot_${config.assetHubParaId}`;
  const assetHub = bridgeInfo.registry.parachains[parachainKey];
  const rpcUrl = getAssetHubRpcUrl(config, bridgeInfo);

  if (!assetHub || !rpcUrl) {
    throw new Error(`Missing Asset Hub registry configuration for ${assetHubChain.name}.`);
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(rpcUrl),
    noInitWarn: true,
  });

  try {
    const nativeAccount = (await api.query.system.account(args.walletAddress)).toPrimitive() as any;
    const nativeRawAmount = BigInt(nativeAccount?.data?.free ?? 0n);

    const balances: AssetBalance[] = [];

    if (nativeRawAmount > 0n) {
      balances.push({
        key: "native",
        symbol: assetSymbol(assetHub.info.tokenSymbols),
        decimals: Number(assetHub.info.tokenDecimals ?? 0),
        isNative: true,
        rawAmount: nativeRawAmount,
        displayAmount: formatBalanceDisplay(nativeRawAmount, Number(assetHub.info.tokenDecimals ?? 0)),
      });
    }

    const assetEntries = Object.entries(assetHub.assets as Record<string, SubstrateAssetRecord>);
    const assetBalances = await Promise.all(
      assetEntries.map(([tokenAddress, asset]) =>
        readSubstrateAssetBalance({
          api,
          walletAddress: args.walletAddress,
          ethChainId: bridgeInfo.registry.ethChainId,
          tokenAddress,
          asset,
        })
      )
    );

    for (const balance of assetBalances) {
      if (balance) balances.push(balance);
    }

    return balances.sort(sortBalances);
  } finally {
    await api.disconnect();
  }
}

export async function fetchNonZeroBalances(args: {
  env: Env;
  chain: Chain;
  walletAddress: string;
}): Promise<AssetBalance[]> {
  if (args.chain.type === "substrate") {
    return fetchAssetHubBalances({
      env: args.env,
      chain: args.chain,
      walletAddress: args.walletAddress,
    });
  }

  return fetchEvmBalances(args);
}
