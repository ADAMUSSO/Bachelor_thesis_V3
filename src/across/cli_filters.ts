import { AcrossApi, type AcrossEnv } from "./acrossApi";

const env = (process.argv[2] as AcrossEnv) ?? "testnet";
const origin = Number(process.argv[3]);
const dest = Number(process.argv[4]);

async function main() {
  const api = new AcrossApi(env);

  if (!Number.isFinite(origin) || !Number.isFinite(dest)) {
    console.log("Usage: npx tsx src/across/cli_filters.ts <env> <originChainId> <destinationChainId>");
    process.exit(1);
  }

  const routes = await api.availableRoutes({ originChainId: origin, destinationChainId: dest });

  console.log("rawRouteCount:", routes.length);
  console.log("firstRouteKeys:", routes[0] ? Object.keys(routes[0]) : []);
  console.log("firstRouteSample:", JSON.stringify(routes[0], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
