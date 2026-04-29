import type { AcrossRoute, Chain, Env, Token } from "./types";
import { bridgeInfoFor } from "@snowbridge/registry";

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;
export const ASSET_HUB_PARA_ID = 1000;
export const WESTEND_ASSETHUB_CHAIN_ID = 10001000;

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
export type SnowbridgeBridgeEnv = "polkadot_mainnet" | "paseo_sepolia" | "westend_sepolia";

export type SnowbridgeRuntimeConfig = {
  env: Env;
  bridgeEnv: SnowbridgeBridgeEnv;
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

export const WESTEND_ASSETHUB_CHAIN: Chain = {
  id: "westend-assethub",
  chainId: WESTEND_ASSETHUB_CHAIN_ID,
  name: "Westend Asset Hub",
  type: "substrate",
};

const MAINNET_SNOWBRIDGE_CONFIGS: SnowbridgeRuntimeConfig[] = [
  {
    env: "mainnet",
    bridgeEnv: "polkadot_mainnet",
    l1ChainId: ETHEREUM_MAINNET_CHAIN_ID,
    assetHubParaId: ASSET_HUB_PARA_ID,
    destinationChain: POLKADOT_ASSETHUB_CHAIN,
    destinationName: POLKADOT_ASSETHUB_CHAIN.name,
  },
];

const TESTNET_SNOWBRIDGE_CONFIGS: SnowbridgeRuntimeConfig[] = [
  {
    env: "testnet",
    bridgeEnv: "paseo_sepolia",
    l1ChainId: SEPOLIA_CHAIN_ID,
    assetHubParaId: ASSET_HUB_PARA_ID,
    destinationChain: PASEO_ASSETHUB_CHAIN,
    destinationName: PASEO_ASSETHUB_CHAIN.name,
  },
  {
    env: "testnet",
    bridgeEnv: "westend_sepolia",
    l1ChainId: SEPOLIA_CHAIN_ID,
    assetHubParaId: ASSET_HUB_PARA_ID,
    destinationChain: WESTEND_ASSETHUB_CHAIN,
    destinationName: WESTEND_ASSETHUB_CHAIN.name,
  },
];

export function getSnowbridgeConfigs(env: Env): SnowbridgeRuntimeConfig[] {
  return env === "mainnet" ? MAINNET_SNOWBRIDGE_CONFIGS : TESTNET_SNOWBRIDGE_CONFIGS;
}

export function getSnowbridgeConfig(env: Env, selector?: SnowbridgeBridgeEnv | number): SnowbridgeRuntimeConfig {
  const configs = getSnowbridgeConfigs(env);
  const match =
    typeof selector === "string"
      ? configs.find((config) => config.bridgeEnv === selector)
      : typeof selector === "number"
        ? configs.find((config) => config.destinationChain.chainId === selector)
        : undefined;

  return match ?? configs[0];
}

export function isSnowbridgeDestination(chainId: number): boolean {
  return getSnowbridgeConfigs("mainnet").some((config) => config.destinationChain.chainId === chainId) ||
    getSnowbridgeConfigs("testnet").some((config) => config.destinationChain.chainId === chainId);
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

export function isSnowbridgeTokenSupported(env: Env, tokenKey: string, bridgeEnv?: SnowbridgeBridgeEnv): boolean {
  const tokenAddress = tokenAddressFromKey(tokenKey);
  if (!tokenAddress) return false;

  const config = getSnowbridgeConfig(env, bridgeEnv);
  const { registry } = bridgeInfoFor(config.bridgeEnv);
  const ethAssets = registry.ethereumChains[`ethereum_${registry.ethChainId}`]?.assets;
  const assetHubAssets = registry.parachains[`polkadot_${registry.assetHubParaId}`]?.assets;

  return !!ethAssets?.[tokenAddress] && !!assetHubAssets?.[tokenAddress];
}

export function getSnowbridgeTokenSymbol(env: Env, tokenKey: string, bridgeEnv?: SnowbridgeBridgeEnv): string {
  const tokenAddress = tokenAddressFromKey(tokenKey);
  if (!tokenAddress) return "Token";

  const config = getSnowbridgeConfig(env, bridgeEnv);
  const { registry } = bridgeInfoFor(config.bridgeEnv);
  const asset =
    registry.ethereumChains[`ethereum_${registry.ethChainId}`]?.assets[tokenAddress] ??
    registry.parachains[`polkadot_${registry.assetHubParaId}`]?.assets[tokenAddress];

  return asset?.symbol || (tokenKey === "native" ? "ETH" : "Token");
}

export function resolveSnowbridgeTokenForTransfer(params: {
  env: Env;
  originChainId: number;
  destinationChainId?: number;
  tokenKey: string;
  routes?: AcrossRoute[];
}): string | null {
  const config = getSnowbridgeConfig(params.env, params.destinationChainId);

  if (params.originChainId === config.l1ChainId) {
    return isSnowbridgeTokenSupported(params.env, params.tokenKey, config.bridgeEnv) ? params.tokenKey : null;
  }

  for (const route of params.routes ?? []) {
    if (route.originChainId !== params.originChainId) continue;
    if (route.destinationChainId !== config.l1ChainId) continue;
    if (!routeMatchesToken(route, params.tokenKey)) continue;

    const l1TokenKey = tokenKeyFromRouteDestination(route);
    if (isSnowbridgeTokenSupported(params.env, l1TokenKey, config.bridgeEnv)) return l1TokenKey;
  }

  return null;
}

export function supportsSnowbridgeDestination(params: {
  env: Env;
  originChainId: number;
  destinationChainId?: number;
  tokenKey: string;
  routes?: AcrossRoute[];
}): boolean {
  return resolveSnowbridgeTokenForTransfer(params) !== null;
}

export function getSnowbridgeAssetHubTokens(env: Env, assetHubChainId?: number): Token[] {
  const config = getSnowbridgeConfig(env, assetHubChainId);
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
  sourceChainId?: number;
  bridgeEnv?: SnowbridgeBridgeEnv;
}): boolean {
  const config = getSnowbridgeConfig(params.env, params.bridgeEnv ?? params.sourceChainId);
  return (
    params.destinationChainId === config.l1ChainId &&
    isSnowbridgeTokenSupported(params.env, params.tokenKey, config.bridgeEnv)
  );
}

export function supportsSnowbridgeSourceDestination(params: {
  env: Env;
  destinationChainId: number;
  tokenKey: string;
  sourceChainId?: number;
  bridgeEnv?: SnowbridgeBridgeEnv;
  routes?: AcrossRoute[];
}): boolean {
  const config = getSnowbridgeConfig(params.env, params.bridgeEnv ?? params.sourceChainId);
  const supportsL1 = supportsSnowbridgeSource({
    env: params.env,
    destinationChainId: config.l1ChainId,
    tokenKey: params.tokenKey,
    bridgeEnv: config.bridgeEnv,
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
  sourceChainId: number;
  tokenKey: string;
  chains: Chain[];
  routes?: AcrossRoute[];
}): Chain[] {
  const config = getSnowbridgeConfig(params.env, params.sourceChainId);
  const destinations = new Map<number, Chain>();

  for (const chain of params.chains) {
    if (chain.chainId === config.assetHubParaId) continue;
    if (
      supportsSnowbridgeSourceDestination({
        env: params.env,
        destinationChainId: chain.chainId,
        tokenKey: params.tokenKey,
        bridgeEnv: config.bridgeEnv,
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
  return getSnowbridgeConfigs(params.env)
    .filter((config) =>
      supportsSnowbridgeDestination({
        ...params,
        destinationChainId: config.destinationChain.chainId,
      })
    )
    .map((config) => config.destinationChain);
}

export function getSnowbridgeProgressLabel(originChainId: number, bridgeEnv?: SnowbridgeBridgeEnv): string {
  if (originChainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return "Snowbridge Ethereum -> Polkadot Asset Hub";
  }

  if (originChainId === SEPOLIA_CHAIN_ID) {
    if (bridgeEnv === "westend_sepolia") return "Snowbridge Sepolia -> Westend Asset Hub";
    return "Snowbridge Sepolia -> Paseo Asset Hub";
  }

  return "Snowbridge to Asset Hub";
}
