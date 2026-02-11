import { ApiPromise, WsProvider } from "@polkadot/api";

const RPC = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const ADDRESS = "5DoPapsqcWDZJSofhL6VamAtJXJUicNdGWQnmURKTYLzaqbh";

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(RPC) });

  console.log("Connected to Paseo AssetHub");
  console.log("Checking FOREIGN assets for:", ADDRESS);
  console.log("--------------------------------------");

  // skontroluj, či chain vôbec má pallet foreignAssets
  if (!api.query.foreignAssets?.account) {
    console.error("This chain does not expose foreignAssets.account storage.");
    console.error("Available pallets include:", Object.keys(api.query).slice(0, 30), "...");
    await api.disconnect();
    process.exit(1);
  }

  const entries = await api.query.foreignAssets.account.entries();
  let found = false;

  for (const [key, value] of entries) {
    const [assetId, accountId] = key.args;

    if (accountId.toString() === ADDRESS) {
      // value typicky vyzerá ako { balance, status } alebo podobne
      console.log("ForeignAsset ID:", assetId.toString());
      console.log("Balance:", value.toHuman());
      console.log("--------------------------------------");
      found = true;
    }
  }

  if (!found) console.log("No foreign assets found for this address.");

  await api.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
