import type { Chain, Env } from "./types";

export const SEPOLIA_CHAIN_ID = 11155111;
export const PASEO_ASSETHUB_PARA_ID = 1000;

const L2_TESTNET_SOURCE_CHAIN_IDS = new Set<number>([84532, 11155420, 421614]);

export const PASEO_ASSETHUB_CHAIN: Chain = {
  id: "paseo-assethub",
  chainId: PASEO_ASSETHUB_PARA_ID,
  name: "Paseo Asset Hub",
  type: "substrate",
};

export function isPaseoAssetHubDestination(chainId: number): boolean {
  return chainId === PASEO_ASSETHUB_PARA_ID;
}

export function supportsSnowbridgeDestination(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
}): boolean {
  if (params.env !== "testnet") return false;
  if (params.tokenKey !== "native") return false;

  return (
    params.originChainId === SEPOLIA_CHAIN_ID || L2_TESTNET_SOURCE_CHAIN_IDS.has(params.originChainId)
  );
}

export function getSnowbridgeDestinations(params: {
  env: Env;
  originChainId: number;
  tokenKey: string;
}): Chain[] {
  return supportsSnowbridgeDestination(params) ? [PASEO_ASSETHUB_CHAIN] : [];
}
