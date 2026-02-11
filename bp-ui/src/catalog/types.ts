export type Env = "mainnet" | "testnet";

export type Chain = {
  id: string;          // string pre unified UI
  chainId: number;     // EVM chainId
  name: string;
  type: "evm";
};

export type Token = {
  key: string;         // "native" | `erc20:${addressLower}`
  symbol: string;
  address?: string;    // iba pre ERC20
  decimals: number;
  chainId: number;
  isNative: boolean;
};


export type AcrossRoute = {
  originChainId: number;
  destinationChainId: number;

  originToken: string;       // address
  destinationToken: string;  // address

  originTokenSymbol?: string;
  destinationTokenSymbol?: string;

  isNative?: boolean;
};

