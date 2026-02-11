// across-base-sepolia-to-sepolia.ts
// Run: npx tsx across-base-sepolia-to-sepolia.ts
//
//
// Notes:
// - Uses Across testnet Swap API: https://testnet.across.to/api
// - Base Sepolia chainId=84532, Ethereum Sepolia chainId=11155111

import "dotenv/config";
import axios from "axios";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ACROSS_TESTNET_API = "https://testnet.across.to/api";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const pk = reqEnv("ETHEREUM_KEY") as `0x${string}`;
  const rpc = reqEnv("BASE_SEPOLIA_RPC");

  // Amount to bridge (edit this)
  const amountWei = parseEther("0.001");

  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpc),
  });

  const originChainId = 84532;       // Base Sepolia
  const destinationChainId = 11155111; // Ethereum Sepolia

  // Across Swap API expects token addresses.
  // For native ETH, Across commonly uses the zero address in its token objects.
  const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

  // 1) Ask Across for a ready-to-execute swap/bridge tx
  // tradeType: "exactInput" means you specify exact input amount
  const { data } = await axios.get(`${ACROSS_TESTNET_API}/swap/approval`, {
    params: {
      tradeType: "exactInput",
      amount: amountWei.toString(),
      inputToken: NATIVE_ETH,
      outputToken: NATIVE_ETH,
      originChainId,
      destinationChainId,
      depositor: account.address,
      // recipient: account.address, // optional; defaults to depositor
      slippage: "auto",
    },
  });

  // Response includes swapTx with { chainId, to, data, gas, maxFeePerGas, maxPriorityFeePerGas, ... }
  const swapTx = data?.swapTx;
  if (!swapTx?.to || !swapTx?.data) {
    throw new Error(`Across /swap/approval did not return swapTx. Raw: ${JSON.stringify(data, null, 2)}`);
  }

  console.log("Across swapTx:", {
    chainId: swapTx.chainId,
    to: swapTx.to,
    gas: swapTx.gas,
    maxFeePerGas: swapTx.maxFeePerGas,
    maxPriorityFeePerGas: swapTx.maxPriorityFeePerGas,
  });

  // 2) Send the transaction on Base Sepolia (origin chain)
  const hash = await wallet.sendTransaction({
    to: swapTx.to,
    data: swapTx.data,
    // For native ETH input, send value=amountWei
    value: amountWei,
    gas: swapTx.gas ? BigInt(swapTx.gas) : undefined,
    maxFeePerGas: swapTx.maxFeePerGas ? BigInt(swapTx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: swapTx.maxPriorityFeePerGas ? BigInt(swapTx.maxPriorityFeePerGas) : undefined,
  });

  console.log("Deposit tx sent on Base Sepolia:", hash);

  // Optional: you can track later via /deposits or /deposit/status endpoints,
  // but simplest is to just wait ~1 min and check Sepolia balance.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


