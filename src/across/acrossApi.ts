export type AcrossEnv = "mainnet" | "testnet";

const BASE: Record<AcrossEnv, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

export type AcrossRoute = {
  originChainId: number;
  destinationChainId: number;

  // niekedy objekty:
  inputToken?: { address: string; symbol?: string; decimals?: number; name?: string };
  outputToken?: { address: string; symbol?: string; decimals?: number; name?: string };

  // často stringy podľa /available-routes:
  originToken?: string | { address: string; symbol?: string; decimals?: number; name?: string };
  destinationToken?: string | { address: string; symbol?: string; decimals?: number; name?: string };

  [k: string]: any;
};

export function pickOriginTokenAddress(r: AcrossRoute): string | null {
  const v: any = r.originToken ?? r.inputToken;
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v.address) return v.address;
  return null;
}

export function pickDestinationTokenAddress(r: AcrossRoute): string | null {
  const v: any = r.destinationToken ?? r.outputToken;
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v.address) return v.address;
  return null;
}


export type TokenRef = {
  chainId: number;
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
};

export class AcrossApi {
  constructor(private env: AcrossEnv) {}

  private baseUrl() {
    return BASE[this.env];
  }

  async availableRoutes(params: {
    originChainId?: number;
    destinationChainId?: number;
    inputToken?: string;
    outputToken?: string;
  }): Promise<AcrossRoute[]> {
    const url = new URL(this.baseUrl() + "/available-routes");
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }

    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Across /available-routes failed: ${res.status} ${text}`);
    }
    return (await res.json()) as AcrossRoute[];
  }
}

// Helpers: vyber input/output token bez ohľadu na názov poľa
export function pickInputToken(r: AcrossRoute) {
  return r.inputToken ?? r.originToken ?? null;
}
export function pickOutputToken(r: AcrossRoute) {
  return r.outputToken ?? r.destinationToken ?? null;
}
