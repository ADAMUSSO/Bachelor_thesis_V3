function requiredRpc(name: string, chainId: number): string {
  const env = import.meta.env as any;
  const value = env[name];
  if (!value) {
    throw new Error(`Missing RPC env ${name} for chainId=${chainId}`);
  }
  return value;
}

export function getRpcUrl(chainId: number): string {
  switch (chainId) {
    case 1:
      return requiredRpc("VITE_RPC_ETHEREUM", chainId);
    case 10:
      return requiredRpc("VITE_RPC_OP", chainId);
    case 8453:
      return requiredRpc("VITE_RPC_BASE", chainId);
    case 42161:
      return requiredRpc("VITE_RPC_ARBITRUM", chainId);
    case 11155111:
      return requiredRpc("VITE_RPC_SEPOLIA", chainId);
    case 84532:
      return requiredRpc("VITE_RPC_BASE_SEPOLIA", chainId);
    case 11155420:
      return requiredRpc("VITE_RPC_OP_SEPOLIA", chainId);
    case 421614:
      return requiredRpc("VITE_RPC_ARBITRUM_SEPOLIA", chainId);
    case 80002:
      return requiredRpc("VITE_RPC_POLYGON_AMOY", chainId);
    default:
      throw new Error(`Missing RPC mapping for chainId=${chainId}`);
  }
}
