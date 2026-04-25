import type { AcrossRoute, Chain, Env, Token } from "./types";
import { bridgeInfoFor } from "@snowbridge/registry";

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;
export const ASSET_HUB_PARA_ID = 1000;

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
const TESTNET_L2_DESTINATION_CHAIN_IDS = new Set<number>([84532, 11155420, 421614]);
const MAINNET_L2_DESTINATION_CHAIN_IDS = new Set<number>([8453, 10, 42161]);

export type SnowbridgeRuntimeConfig = {
  env: Env;
  bridgeEnv: "polkadot_mainnet" | "paseo_sepolia";
  l1ChainId: number;
  assetHubParaId: number;
  destinationChain: Chain;
  destinationName: string;
};

export const PASEO_ASSETHUB_CHAIN: Chain = {
  id: "paseo-assethub",
  chainId: ASSET_HUB_PARA_ID,
  name: "Paseo Asset Hub",
  type: "substrate",
};

export const POLKADOT_ASSETHUB_CHAIN: Chain = {
  id: "polkadot-assethub",
  chainId: ASSET_HUB_PARA_ID,
  name: "Polkadot Asset Hub",
  type: "substrate",
};

export function getSnowbridgeConfig(env: Env): SnowbridgeRuntimeConfig {
  if (env === "mainnet") {
    return {
      env,
      bridgeEnv: "polkadot_mainnet",
      l1ChainId: ETHEREUM_MAINNET_CHAIN_ID,
      assetHubParaId: ASSET_HUB_PARA_ID,
      destinationChain: POLKADOT_ASSETHUB_CHAIN,
      destinationName: POLKADOT_ASSETHUB_CHAIN.name,
    };
  }

  return {
    env,
    bridgeEnv: "paseo_sepolia",
    l1ChainId: SEPOLIA_CHAIN_ID,
    assetHubParaId: ASSET_HUB_PARA_ID,
    destinationChain: PASEO_ASSETHUB_CHAIN,
    destinationName: PASEO_ASSETHUB_CHAIN.name,
  };
}

export function isSnowbridgeDestination(chainId: number): boolean {
  return chainId === ASSET_HUB_PARA_ID;
}

function tokenAddressFromKey(tokenKey: string): string | null {
  if (tokenKey === "native") return NATIVE_TOKEN_ADDRESS;
  return tokenKey.startsWith("erc20:") ? tokenKey.slice("erc20:".length).toLowerCase() : null;
}

function tokenKeyFromAddress(address: string): string {
  const normalized = address.toLowerCase();
  return normalized === NATIVE_TOKEN_ADDRESS ? "native" : `erc20:${normalized}`;
}

function tokenKeyFromRouteDestination(route: AcrossRoute): string {
  return route.isNative ? "native" : `erc20:${route.destinationToken.toLowerCase()}`;
}

function routeMatchesToken(route: AcrossRoute, tokenKey: string): boolean {
  if (tokenKey === "native") return !!route.isNative;
  const tokenAddress = tokenAddressFromKey(tokenKey);
  return !!tokenAddress && !route.isNative && route.originToken.toLowerCase() === tokenAddress;
}

export function isSnowbridgeTokenSupported(env: Env, tokenKey: string): boolean {
  const tokenAddress = tokenAddressFromKey(tokenKey);
  if (!tokenAddress) return false;

  const config = getSnowbridgeConfig(env);
  const { registry } = bridgeInfoFor(config.bridgeEnv);
  const ethAssets = registry.ethereumChains[`ethereum_${registry.ethChainId}`]?.assets;
  const assetHubAssets = registry.parachains[`polkadot_${registry.assetHubParaId}`]?.assets;

  return !!ethAssets?.[tokenAddress] && !!assetHubAssets?.[tokenAddress];
}

export function getSnowbridgeTokenSymbol(env: Env, tokenKey: string): string {
  const tokenAddress = tokenAddressFromKey(tokenKey);
  if (!tokenAddress) return "Token";

  const config = getSnowbridgeConfig(env);
  const { registry } = bridgeInfoFor(config.bridgeEnv);
  const asset =
    registry.ethereumChains[`ethereum_${registry.ethChainId}`]?.assets[tokenAddress] ??
    registry.parachains[`polkadot_${registry.assetHubParaId}`]?.assets[tokenAddress];

  return asset?.symbol || (tokenKey === "native" ? "ETH" : "Token");
}

export function resolveSnowbridgeTokenForTransfer(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
  routes?: AcrossRoute[];
}): string | null {
  const config = getSnowbridgeConfig(params.env);

  if (params.originChainId === config.l1ChainId) {
    return isSnowbridgeTokenSupported(params.env, params.tokenKey) ? params.tokenKey : null;
  }

  for (const route of params.routes ?? []) {
    if (route.originChainId !== params.originChainId) continue;
    if (route.destinationChainId !== config.l1ChainId) continue;
    if (!routeMatchesToken(route, params.tokenKey)) continue;

    const l1TokenKey = tokenKeyFromRouteDestination(route);
    if (isSnowbridgeTokenSupported(params.env, l1TokenKey)) return l1TokenKey;
  }

  return null;
}

export function supportsSnowbridgeDestination(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
  routes?: AcrossRoute[];
}): boolean {
  return resolveSnowbridgeTokenForTransfer(params) !== null;
}

export function getSnowbridgeAssetHubTokens(env: Env): Token[] {
  const config = getSnowbridgeConfig(env);
  const { registry } = bridgeInfoFor(config.bridgeEnv);
  const ethAssets = registry.ethereumChains[`ethereum_${registry.ethChainId}`]?.assets ?? {};
  const assetHubAssets = registry.parachains[`polkadot_${registry.assetHubParaId}`]?.assets ?? {};

  return Object.entries(assetHubAssets)
    .filter(([address]) => !!ethAssets[address.toLowerCase()])
    .map(([address, asset]: [string, any]) => {
      const normalized = address.toLowerCase();
      const ethAsset = ethAssets[normalized];
      const isNativeEth = normalized === NATIVE_TOKEN_ADDRESS;

      return {
        key: tokenKeyFromAddress(normalized),
        symbol: asset.symbol || ethAsset?.symbol || (isNativeEth ? "ETH" : "Token"),
        address: isNativeEth ? undefined : normalized,
        decimals: Number(asset.decimals ?? ethAsset?.decimals ?? 18),
        chainId: config.assetHubParaId,
        isNative: isNativeEth,
      };
    });
}

export function supportsSnowbridgeSource(params: {
  env: Env;
  destinationChainId: number;
  tokenKey: string;
}): boolean {
  const config = getSnowbridgeConfig(params.env);
  return (
    params.env !== "testnet" &&
    params.destinationChainId === config.l1ChainId &&
    isSnowbridgeTokenSupported(params.env, params.tokenKey)
  );
}

export function supportsSnowbridgeSourceDestination(params: {
  env: Env;
  destinationChainId: number;
  tokenKey: string;
  routes?: AcrossRoute[];
}): boolean {
  const config = getSnowbridgeConfig(params.env);
  const supportsL1 = supportsSnowbridgeSource({
    env: params.env,
    destinationChainId: config.l1ChainId,
    tokenKey: params.tokenKey,
  });

  if (!supportsL1) return false;
  if (params.destinationChainId === config.l1ChainId) return true;

  return (params.routes ?? []).some(
    (route) =>
      route.originChainId === config.l1ChainId &&
      route.destinationChainId === params.destinationChainId &&
      routeMatchesToken(route, params.tokenKey)
  );
}

export function getSnowbridgeSourceDestinations(params: {
  env: Env;
  tokenKey: string;
  chains: Chain[];
  routes?: AcrossRoute[];
}): Chain[] {
  const config = getSnowbridgeConfig(params.env);
  const destinations = new Map<number, Chain>();
  const l2Destinations = params.env === "mainnet" ? MAINNET_L2_DESTINATION_CHAIN_IDS : TESTNET_L2_DESTINATION_CHAIN_IDS;

  for (const chain of params.chains) {
    if (chain.chainId === config.assetHubParaId) continue;
    if (chain.chainId !== config.l1ChainId && !l2Destinations.has(chain.chainId)) continue;
    if (
      supportsSnowbridgeSourceDestination({
        env: params.env,
        destinationChainId: chain.chainId,
        tokenKey: params.tokenKey,
        routes: params.routes,
      })
    ) {
      destinations.set(chain.chainId, chain);
    }
  }

  return Array.from(destinations.values());
}

export function getSnowbridgeDestinations(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
  routes?: AcrossRoute[];
}): Chain[] {
  return supportsSnowbridgeDestination(params) ? [getSnowbridgeConfig(params.env).destinationChain] : [];
}

export function getSnowbridgeProgressLabel(originChainId: number): string {
  if (originChainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return "Snowbridge Ethereum -> Polkadot Asset Hub";
  }

  if (originChainId === SEPOLIA_CHAIN_ID) {
    return "Snowbridge Sepolia -> Paseo Asset Hub";
  }

  return "Snowbridge to Asset Hub";
}
