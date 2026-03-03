import type { Env } from "../../catalog/types";

export type TransferIntent = {
  env: Env;
  originChainId: number;
  destinationChainId: number;
  tokenKey: string; // "native" | "erc20:0x..."
  amount: string;
  recipient: string; // EVM address or Substrate SS58 address
};

export type AcrossTransferStep = {
  kind: "across";
  requiredWallet: "evm";

  originChainId: number;
  destinationChainId: number;
  tokenKey: string;
  recipientMode: "final" | "depositor";
};

export type SnowbridgeTransferStep = {
  kind: "snowbridge";
  requiredWallet: "evm";

  originChainId: number; // Ethereum Sepolia
  destinationParaId: number; // Paseo Asset Hub
  tokenKey: "native";
  amountSource: "input" | "acrossMinOutput";
};

export type TransferStep = AcrossTransferStep | SnowbridgeTransferStep;

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
