import type { AcrossRoute, Env } from "../../catalog/types";
import type { SnowbridgeBridgeEnv } from "../../catalog/snowbridgeCatalog";

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

  originChainId: number; // Ethereum mainnet or Sepolia
  destinationParaId: number; // Polkadot/Paseo Asset Hub
  bridgeEnv: SnowbridgeBridgeEnv;
  tokenKey: string;
  amountSource: "input" | "acrossMinOutput";
};

export type SnowbridgeReverseTransferStep = {
  kind: "snowbridgeReverse";
  requiredWallet: "substrate";

  originParaId: number; // Polkadot/Paseo Asset Hub
  destinationChainId: number; // Ethereum L1 or supported L2
  bridgeEnv: SnowbridgeBridgeEnv;
  tokenKey: string;
  amountSource: "input";
  recipientMode: "final" | "depositor";
};

export type TransferStep = AcrossTransferStep | SnowbridgeTransferStep | SnowbridgeReverseTransferStep;

export type TransferPlan = {
  steps: TransferStep[];
};

export type TransferPlanContext = {
  routes?: AcrossRoute[];
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
