import { AcrossApi, pickInputToken, pickOutputToken, type TokenRef } from "./acrossApi";
import { pickOriginTokenAddress, pickDestinationTokenAddress } from "./acrossApi";

function uniqNums(values: number[]) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function uniqTokens(tokens: TokenRef[]) {
  const m = new Map<string, TokenRef>();
  for (const t of tokens) {
    const key = `${t.chainId}:${t.address.toLowerCase()}`;
    if (!m.has(key)) m.set(key, t);
  }
  return Array.from(m.values()).sort((a, b) => {
    const as = (a.symbol ?? "").localeCompare(b.symbol ?? "");
    if (as !== 0) return as;
    return a.address.localeCompare(b.address);
  });
}

/** Source -> Destinations */
export async function getDestinationsForOrigin(api: AcrossApi, originChainId: number) {
  const routes = await api.availableRoutes({ originChainId });
  return uniqNums(routes.map(r => r.destinationChainId).filter(Boolean));
}

/** Destination -> Sources (zrkadlo) */
export async function getOriginsForDestination(api: AcrossApi, destinationChainId: number) {
  const routes = await api.availableRoutes({ destinationChainId });
  return uniqNums(routes.map(r => r.originChainId).filter(Boolean));
}

/** (Source, Destination) -> Send/Receive tokens */
export async function getTokensForPair(api: AcrossApi, originChainId: number, destinationChainId: number) {
  const routes = await api.availableRoutes({ originChainId, destinationChainId });

  const sendTokens: TokenRef[] = [];
  const receiveTokens: TokenRef[] = [];

  for (const r of routes) {
    const aIn = pickOriginTokenAddress(r);
const aOut = pickDestinationTokenAddress(r);

if (aIn) sendTokens.push({ chainId: originChainId, address: aIn });
if (aOut) receiveTokens.push({ chainId: destinationChainId, address: aOut });
  }

  return {
    sendTokens: uniqTokens(sendTokens),
    receiveTokens: uniqTokens(receiveTokens),
    rawRouteCount: routes.length,
  };
}
