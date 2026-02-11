// src/scripts/checkAcross.ts
// Run:
//   npx tsx src/scripts/checkAcross.ts testnet
//   npx tsx src/scripts/checkAcross.ts mainnet

type Env = "mainnet" | "testnet";

const BASE: Record<Env, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

function asEnv(v?: string): Env {
  return v === "mainnet" ? "mainnet" : "testnet";
}

async function main() {
  const env = asEnv(process.argv[2]);
  const url = `${BASE[env]}/available-routes`;

  console.log("Env:", env);
  console.log("GET:", url);

  const res = await fetch(url);
  console.log("Status:", res.status, res.statusText);
  console.log("Content-Type:", res.headers.get("content-type"));

  const text = await res.text();
  console.log("Raw length:", text.length);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error("❌ Not JSON. First 500 chars:\n", text.slice(0, 500));
    process.exit(1);
  }

  const keys = json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : [];
  console.log("Top-level isArray:", Array.isArray(json));
  if (keys.length) console.log("Top-level keys:", keys);

  const routes = Array.isArray(json)
    ? json
    : Array.isArray(json?.routes)
    ? json.routes
    : Array.isArray(json?.availableRoutes)
    ? json.availableRoutes
    : Array.isArray(json?.data)
    ? json.data
    : null;

  if (!routes) {
    console.error("❌ Could not find routes array in response.");
    console.log("Sample top-level:", JSON.stringify(json, null, 2).slice(0, 1200));
    process.exit(1);
  }

  console.log("✅ Routes count:", routes.length);

  const sample = routes[0];
  console.log("Sample route keys:", sample ? Object.keys(sample) : []);
  console.log("Sample route:", JSON.stringify(sample, null, 2));

  // quick stats: unique chainIds
  const origins = new Set<number>();
  const dests = new Set<number>();

  for (const r of routes) {
    if (typeof r?.originChainId === "number") origins.add(r.originChainId);
    if (typeof r?.destinationChainId === "number") dests.add(r.destinationChainId);
  }

  console.log("Unique origins:", origins.size, [...origins].sort((a, b) => a - b));
  console.log("Unique destinations:", dests.size, [...dests].sort((a, b) => a - b));
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
