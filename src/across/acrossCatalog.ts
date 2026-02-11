// src/across/interactive_routes.ts
// Run: npx tsx src/across/interactive_routes.ts

import axios from "axios";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Env = "mainnet" | "testnet";

type ChainEntry = { name: string; chainId: number };
type ChainsJson = { mainnet: ChainEntry[]; testnet: ChainEntry[] };

type AvailableRoute = {
  originChainId: number;
  destinationChainId: number;
  originToken?: string;          // address
  destinationToken?: string;     // address
  originTokenSymbol?: string;
  destinationTokenSymbol?: string;
  isNative?: boolean;
  [k: string]: any;
};

const CHAINS: ChainsJson = {
  mainnet: [
    { name: "Arbitrum", chainId: 42161 },
    { name: "Base", chainId: 8453 },
    { name: "Blast", chainId: 81457 },
    { name: "BNB Smart Chain", chainId: 56 },
    { name: "Ethereum", chainId: 1 },
    { name: "HyperEVM", chainId: 999 },
    { name: "Ink", chainId: 57073 },
    { name: "Lens", chainId: 232 },
    { name: "Linea", chainId: 59144 },
    { name: "Lisk", chainId: 1135 },
    { name: "MegaETH", chainId: 4326 },
    { name: "Mode", chainId: 34443 },
    { name: "Monad", chainId: 143 },
    { name: "Optimism", chainId: 10 },
    { name: "Plasma", chainId: 9745 },
    { name: "Polygon", chainId: 137 },
    { name: "Scroll", chainId: 534352 },
    { name: "Soneium", chainId: 1868 },
    { name: "Solana", chainId: 34268394551451 },
    { name: "Unichain", chainId: 130 },
    { name: "World Chain", chainId: 480 },
    { name: "zkSync", chainId: 324 },
    { name: "Zora", chainId: 7777777 }
  ],
  testnet: [
    { name: "Arbitrum Sepolia", chainId: 421614 },
    { name: "Base Sepolia", chainId: 84532 },
    { name: "Blast Sepolia", chainId: 168587773 },
    { name: "Ethereum Sepolia", chainId: 11155111 },
    { name: "Lisk Sepolia", chainId: 4202 },
    { name: "Mode Testnet", chainId: 919 },
    { name: "Optimism Sepolia", chainId: 11155420 },
    { name: "Polygon Amoy", chainId: 80002 }
  ]
};

const BASE: Record<Env, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

function isHexAddress(v: any): v is string {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function uniqueBy<T>(arr: T[], keyFn: (x: T) => string) {
  const m = new Map<string, T>();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, x);
  }
  return [...m.values()];
}

async function fetchAvailableRoutes(env: Env, params: Record<string, string | number>) {
  const url = new URL(BASE[env] + "/available-routes");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const { data } = await axios.get(url.toString());
  if (!Array.isArray(data)) throw new Error("Unexpected /available-routes response (not an array)");
  return data as AvailableRoute[];
}

async function chooseIndex(rl: ReturnType<typeof createInterface>, label: string, options: string[]) {
  console.log("\n" + label);
  options.forEach((o, i) => console.log(`  [${i + 1}] ${o}`));

  while (true) {
    const raw = (await rl.question("> ")).trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(`Zadaj číslo 1..${options.length}`);
  }
}

async function main() {
  const rl = createInterface({ input, output });

  try {
    // 1) env
    const envIdx = await chooseIndex(rl, "Vyber prostredie:", ["testnet", "mainnet"]);
    const env: Env = envIdx === 0 ? "testnet" : "mainnet";

    const chains = CHAINS[env];
    const chainById = new Map<number, ChainEntry>(chains.map(c => [c.chainId, c]));

    // 2) source chain (len z JSON)
    const sourceIdx = await chooseIndex(
      rl,
      "Vyber SOURCE chain:",
      chains.map(c => `${c.name} (${c.chainId})`)
    );
    const source = chains[sourceIdx];

    // 3) destination list = available-routes(origin) ∩ json chains
    const routesFromSource = await fetchAvailableRoutes(env, { originChainId: source.chainId });
    const destIdsFromApi = new Set<number>(routesFromSource.map(r => r.destinationChainId));

    const allowedDestinations = chains.filter(c => destIdsFromApi.has(c.chainId) && c.chainId !== source.chainId);
    if (allowedDestinations.length === 0) {
      console.log("\nPre tento source chain sa nenašli žiadne destinations (podľa /available-routes + tvoj JSON filter).");
      return;
    }

    const destIdx = await chooseIndex(
      rl,
      "Vyber DESTINATION chain (len z tvojho JSON, ale povolené Across routami):",
      allowedDestinations.map(c => `${c.name} (${c.chainId})`)
    );
    const dest = allowedDestinations[destIdx];

    // 4) tokeny pre (source, dest)
    const pairRoutes = await fetchAvailableRoutes(env, {
      originChainId: source.chainId,
      destinationChainId: dest.chainId,
    });

    // Extract send tokens (originToken + originTokenSymbol + isNative)
    const sendTokens = uniqueBy(
      pairRoutes
        .map(r => ({
          symbol: r.originTokenSymbol ?? "UNKNOWN",
          address: r.originToken,
          isNative: !!r.isNative,
        }))
        .filter(t => (t.isNative ? true : isHexAddress(t.address))), // native môže byť bez adresy; erc20 musí mať address
      t => `${t.symbol}|${String(t.address ?? "")}|${t.isNative ? "native" : "erc20"}`
    );

    console.log("\n==================================================");
    console.log(`FROM ${source.name} (${source.chainId})`);
    console.log(`  TO ${dest.name} (${dest.chainId})`);
    console.log("--------------------------------------------------");

    if (sendTokens.length === 0) {
      console.log("Nenašli sa žiadne send tokeny (skús iný pár chainov).");
      console.log(`rawRouteCount: ${pairRoutes.length}`);
      return;
    }

    for (const t of sendTokens) {
      const type = t.isNative ? "NATIVE" : "ERC20";
      const addr = t.isNative ? "" : `  ${t.address}`;
      console.log(`  ${t.symbol.padEnd(10)} | ${type}${addr ? "\n    " + addr : ""}`);
    }

    console.log("==================================================\n");
    console.log(`(Pozn.: toto sú tokeny z /available-routes pre daný pár; metadata môže byť 'UNKNOWN' ak API nedá symbol.)`);

  } catch (e: any) {
    console.error(e?.response?.data ?? e);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
