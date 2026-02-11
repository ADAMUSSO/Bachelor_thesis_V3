import * as viemChains from "viem/chains";


function buildMap(): Map<number, string> {
  const map = new Map<number, string>();

  for (const c of Object.values(viemChains) as any[]) {
    if (c && typeof c.id === "number" && typeof c.name === "string") {
      map.set(c.id, c.name);
    }
  }

  return map;
}

const CHAIN_NAME_MAP = buildMap();

export function getEvmChainName(chainId: number): string | null {
  return CHAIN_NAME_MAP.get(chainId) ?? null;
}
