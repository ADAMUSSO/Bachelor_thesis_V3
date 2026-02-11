import type { Env, Chain, Token, AcrossRoute } from "./types";
import { getEvmChainName } from "./evmChainNames";


const BASE: Record<Env, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

let cachedEnv: Env | null = null;
let cachedRoutes: AcrossRoute[] = [];
let lastFetch = 0;
const TTL = 1000 * 60 * 5; // 5 min

function normalizeRoutes(json: any): AcrossRoute[] {
  const arr: any[] | null =
    Array.isArray(json) ? json :
    Array.isArray(json?.routes) ? json.routes :
    Array.isArray(json?.availableRoutes) ? json.availableRoutes :
    Array.isArray(json?.data) ? json.data :
    null;

  if (!arr) throw new Error("Across available-routes: unexpected response shape");

  // Keep only valid route-like entries
  return arr
    .filter(
      (r) =>
        r &&
        typeof r.originChainId === "number" &&
        typeof r.destinationChainId === "number" &&
        typeof r.originToken === "string" &&
        typeof r.destinationToken === "string"
    )
    .map((r) => ({
      originChainId: r.originChainId,
      destinationChainId: r.destinationChainId,
      originToken: r.originToken,
      destinationToken: r.destinationToken,
      originTokenSymbol: r.originTokenSymbol,
      destinationTokenSymbol: r.destinationTokenSymbol,
      isNative: r.isNative,
    }));
}

async function fetchRoutes(env: Env): Promise<AcrossRoute[]> {
  const now = Date.now();

  if (cachedEnv === env && cachedRoutes.length > 0 && now - lastFetch < TTL) {
    return cachedRoutes;
  }

  const res = await fetch(`${BASE[env]}/available-routes`);
  if (!res.ok) throw new Error(`Across available-routes failed (${res.status})`);

  const json: any = await res.json();
  const routes = normalizeRoutes(json);

  cachedEnv = env;
  cachedRoutes = routes;
  lastFetch = now;

  return routes;
}

/* ===========================
   Public API
=========================== */

export async function getAcrossChains(env: Env): Promise<Chain[]> {
  const routes = await fetchRoutes(env);
  const chainIds = new Set<number>();

  for (const r of routes) {
    chainIds.add(r.originChainId);
    chainIds.add(r.destinationChainId);
  }

  return Array.from(chainIds)
    .sort((a, b) => a - b)
    .map((chainId) => {
      const name = getEvmChainName(chainId);
      return name
        ? ({
            id: String(chainId),
            chainId,
            name,
            type: "evm" as const,
          } satisfies Chain)
        : null;
    })
    .filter((x): x is Chain => x !== null);
}


export async function getAcrossTokensForChain(env: Env, chainId: number): Promise<Token[]> {
  const routes = await fetchRoutes(env);

  const map = new Map<string, Token>();

  for (const r of routes) {
    if (r.originChainId !== chainId) continue;

    const isNative = !!r.isNative;

    // ✅ token identity
    const key = isNative ? "native" : `erc20:${r.originToken.toLowerCase()}`;

    if (!map.has(key)) {
      map.set(key, {
        key,
        symbol: r.originTokenSymbol ?? (isNative ? "ETH" : "UNKNOWN"),
        address: isNative ? undefined : r.originToken,
        decimals: 18,
        chainId,
        isNative,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    // native hore, potom abecedne
    if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}


export async function getAcrossDestinations(
  env: Env,
  originChainId: number,
  tokenKey: string
): Promise<Chain[]> {
  const routes = await fetchRoutes(env);

  const destIds = new Set<number>();

  const isNative = tokenKey === "native";
  const addr = tokenKey.startsWith("erc20:") ? tokenKey.slice("erc20:".length) : null;

  for (const r of routes) {
    if (r.originChainId !== originChainId) continue;

    if (isNative) {
      if (r.isNative) destIds.add(r.destinationChainId);
      continue;
    }

    if (addr) {
      if (!r.isNative && r.originToken.toLowerCase() === addr.toLowerCase()) {
        destIds.add(r.destinationChainId);
      }
    }
  }

  return Array.from(destIds)
    .sort((a, b) => a - b)
    .map((chainId) => {
      const name = getEvmChainName(chainId);
      return name
        ? ({ id: String(chainId), chainId, name, type: "evm" as const } satisfies Chain)
        : null;
    })
    .filter((x): x is Chain => x !== null);
}


/* ===========================
   Debug helper
=========================== */

export async function debugAcross(env: Env) {
  const routes = await fetchRoutes(env);
  const chains = await getAcrossChains(env);

  return {
    env,
    routesCount: routes.length,
    chainCount: chains.length,
    sampleRoute: routes[0],
    chainIds: chains.map((c) => c.chainId),
  };
}
