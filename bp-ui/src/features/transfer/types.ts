import type { Env } from "../../catalog/types";

export type TransferIntent = {
  env: Env;
  originChainId: number;
  destinationChainId: number;
  tokenKey: string;        // "native" | "erc20:0x..."
  amount: string;          // zatiaľ string
  recipient: string;       // EVM address
};

export type TransferStep = {
  kind: "across";
  requiredWallet: "evm";

  originChainId: number;
  destinationChainId: number;
  tokenKey: string;
};


export type TransferPlan = {
  steps: TransferStep[];
};


export type AcrossQuote = {
  estimatedFillTimeSec?: number;
  outputAmount?: string;

  totalRelayFeeTotal?: string;
  relayerGasFeeTotal?: string;
  relayerCapitalFeeTotal?: string;
  lpFeeTotal?: string;

  limits?: {
    minDeposit?: string;
    maxDeposit?: string;
    maxDepositInstant?: string;
    maxDepositShortDelay?: string;
    recommendedDepositInstant?: string;
  };

  quoteTimestamp?: string | number;
  spokePoolAddress?: string;
};
