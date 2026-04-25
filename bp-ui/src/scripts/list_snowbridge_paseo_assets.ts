import { bridgeInfoFor } from "@snowbridge/registry";

const ETH_ZERO = "0x0000000000000000000000000000000000000000";

function tokenType(address: string): string {
  return address.toLowerCase() === ETH_ZERO ? "native" : "erc20";
}

function main() {
  const { registry } = bridgeInfoFor("paseo_sepolia");
  const ethChain = registry.ethereumChains[`ethereum_${registry.ethChainId}`];
  const assetHub = registry.parachains[`polkadot_${registry.assetHubParaId}`];

  if (!ethChain || !assetHub) {
    throw new Error("Missing Sepolia or Paseo Asset Hub registry data.");
  }

  const rows = Object.entries(ethChain.assets)
    .filter(([address]) => assetHub.assets[address.toLowerCase()])
    .map(([address, ethAsset]) => {
      const ahAsset = assetHub.assets[address.toLowerCase()];

      return {
        symbol: ahAsset.symbol || ethAsset.symbol || "UNKNOWN",
        type: tokenType(address),
        sepoliaAddress: address,
        decimals: ahAsset.decimals ?? ethAsset.decimals,
        minAssetHubBalance: ahAsset.minimumBalance?.toString?.() ?? "",
        sufficientOnAssetHub: String(ahAsset.isSufficient ?? ""),
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.sepoliaAddress.localeCompare(b.sepoliaAddress));

  console.log("Snowbridge paseo_sepolia: Sepolia -> Paseo Asset Hub");
  console.log(`Ethereum chain id: ${registry.ethChainId}`);
  console.log(`Asset Hub para id: ${registry.assetHubParaId}`);
  console.table(rows);
}

main();
