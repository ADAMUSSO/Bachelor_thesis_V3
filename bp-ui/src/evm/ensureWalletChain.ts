import { getRpcUrl } from "./rpcs";

type AddEthereumChainParameter = {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
};

const CHAIN_CONFIG: Record<number, Omit<AddEthereumChainParameter, "chainId" | "rpcUrls">> = {
  11155111: {
    chainName: "Ethereum Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  },
  84532: {
    chainName: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
  11155420: {
    chainName: "OP Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia-optimism.etherscan.io"],
  },
  421614: {
    chainName: "Arbitrum Sepolia",
    nativeCurrency: { name: "Arbitrum Sepolia Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
  },
  80002: {
    chainName: "Polygon Amoy",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    blockExplorerUrls: ["https://amoy.polygonscan.com"],
  },
};

function chainIdHex(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}

function shouldAddChain(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const message = String((err as { message?: unknown } | null)?.message ?? "").toLowerCase();

  if (code === 4902) return true;

  return (
    message.includes("unrecognized chain id") ||
    message.includes("unknown chain") ||
    message.includes("chain not added") ||
    message.includes("wallet_addethereumchain")
  );
}

function addChainParams(chainId: number): AddEthereumChainParameter {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) {
    throw new Error(`Chain ${chainId} is not configured for wallet_addEthereumChain.`);
  }

  return {
    chainId: chainIdHex(chainId),
    chainName: cfg.chainName,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: [getRpcUrl(chainId)],
    blockExplorerUrls: cfg.blockExplorerUrls,
  };
}

export async function ensureWalletChain(ethereum: any, chainId: number): Promise<void> {
  const switchParams = [{ chainId: chainIdHex(chainId) }];

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: switchParams,
    });
    return;
  } catch (err) {
    if (!shouldAddChain(err)) throw err;
  }

  const params = addChainParams(chainId);

  await ethereum.request({
    method: "wallet_addEthereumChain",
    params: [params],
  });

  await ethereum.request({
    method: "wallet_switchEthereumChain",
    params: switchParams,
  });
}
