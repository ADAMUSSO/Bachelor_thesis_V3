import type { Chain, Env } from "./types";

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;
export const ASSET_HUB_PARA_ID = 1000;

const TESTNET_L2_SOURCE_CHAIN_IDS = new Set<number>([84532, 11155420, 421614]);
const MAINNET_L2_SOURCE_CHAIN_IDS = new Set<number>([8453, 10, 42161]);

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

export function supportsSnowbridgeDestination(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
}): boolean {
  if (params.tokenKey !== "native") return false;

  const config = getSnowbridgeConfig(params.env);
  const l2Sources = params.env === "mainnet" ? MAINNET_L2_SOURCE_CHAIN_IDS : TESTNET_L2_SOURCE_CHAIN_IDS;

  return params.originChainId === config.l1ChainId || l2Sources.has(params.originChainId);
}

export function getSnowbridgeDestinations(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
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
