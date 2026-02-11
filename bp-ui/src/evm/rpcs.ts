export function getRpcUrl(chainId: number): string {
  // Vite env vars musia začínať VITE_
  const env = import.meta.env as any;

  switch (chainId) {
    case 11155111: // Sepolia
      return env.VITE_RPC_SEPOLIA;
    case 84532: // Base Sepolia
      return env.VITE_RPC_BASE_SEPOLIA;
    case 11155420: // OP Sepolia
      return env.VITE_RPC_OP_SEPOLIA;
    case 421614: // Arbitrum Sepolia
      return env.VITE_RPC_ARBITRUM_SEPOLIA;
    case 80002: // Polygon Amoy
      return env.VITE_RPC_POLYGON_AMOY;
    default:
      throw new Error(`Missing RPC mapping for chainId=${chainId}`);
  }
}
