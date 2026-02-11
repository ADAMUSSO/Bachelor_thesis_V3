import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Wallet, formatEther } from "ethers";

import { assetsV2, Context, toPolkadotV2 } from "@snowbridge/api";
import { bridgeInfoFor } from "@snowbridge/registry";

import { ENV } from "../shared/env";

/* --------------------------------- config -------------------------------- */

// Paseo Asset Hub paraId je typicky 1000 (rovnako ako na Polkadot/Kusama svete).
const DESTINATION_PARACHAIN = 1000; // Paseo Asset Hub
const TOKEN_CONTRACT = assetsV2.ETHER_TOKEN_ADDRESS;

// 0.001 ETH
const AMOUNT_WEI = 10_000_000_000_000_000n;

/* ------------------------------- init helpers ------------------------------ */

async function initSubstrateAccount() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const account = keyring.addFromUri(ENV.substrateKey);
  return { account, address: account.address };
}

async function initEthereumWallet(context: Context) {
  // context.ethereum() bude provider pre Sepolia, ak ENV.snowbridgeEnv = "paseo_sepolia"
  const wallet = new Wallet(ENV.ethereumKey, context.ethereum());
  const address = await wallet.getAddress();
  return { wallet, address };
}

function initSnowbridge(env: string) {
  const { registry, environment } = bridgeInfoFor(env as any);
  const context = new Context(environment);
  return { registry, context };
}

/* ---------------------------- core transfer flow --------------------------- */

async function buildAndValidateTransfer(params: {
  context: Context;
  registry: any;
  fromEth: string;
  toSubstrate: string;
}) {
  const { context, registry, fromEth, toSubstrate } = params;

  const fee = await toPolkadotV2.getDeliveryFee(
    context,
    registry,
    TOKEN_CONTRACT,
    DESTINATION_PARACHAIN
  );

  const transfer = await toPolkadotV2.createTransfer(
    registry,
    fromEth,
    toSubstrate,
    TOKEN_CONTRACT,
    DESTINATION_PARACHAIN,
    AMOUNT_WEI,
    fee
  );

  const validation = await toPolkadotV2.validateTransfer(context, transfer);
  if (!validation.success) {
    throw new Error(`Validation failed:\n${(validation.logs ?? []).join("\n")}`);
  }

  return { fee, transfer, validation };
}

async function submitAndReport(params: { ethWallet: Wallet; transfer: any }) {
  const { ethWallet, transfer } = params;

  const response = await ethWallet.sendTransaction(transfer.tx);
  const receipt = await response.wait(1);

  if (!receipt) throw new Error(`Transaction ${response.hash} not included`);

  const message = await toPolkadotV2.getMessageReceipt(receipt);
  if (!message) {
    throw new Error(`Transaction ${receipt.hash} did not emit a bridge message`);
  }

  console.log("--------------------------------------------------");
  console.log("✅ Ethereum (Sepolia) transaction successful");
  console.log("Tx hash:   ", receipt.hash);
  console.log("Block:     ", receipt.blockNumber);
  console.log("MessageId: ", message.messageId);
  console.log("--------------------------------------------------");
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  // Dôležité: nastav env na Sepolia <-> Paseo
  // napr. ENV.snowbridgeEnv = "paseo_sepolia"
  console.log("Snowbridge env:", ENV.snowbridgeEnv);

  const { registry, context } = initSnowbridge(ENV.snowbridgeEnv);
  const { wallet: ethWallet, address: ethAddr } = await initEthereumWallet(context);
  const { address: subAddr } = await initSubstrateAccount();

  console.log("eth:", ethAddr);
  console.log("sub:", subAddr);

  console.log("# Ethereum Sepolia -> Paseo Asset Hub");

  const { fee, transfer, validation } = await buildAndValidateTransfer({
    context,
    registry,
    fromEth: ethAddr,
    toSubstrate: subAddr,
  });

  console.log("Amount:", formatEther(AMOUNT_WEI), "ETH");
  console.log("Gas price quoted:", validation.data.feeInfo?.feeData?.toJSON?.());
  console.log("Estimated gas:", validation.data.feeInfo?.estimatedGas?.toString?.());

  console.log("Delivery Fee:", formatEther(fee.totalFeeInWei));
  console.log("Execution Fee:", formatEther(validation.data.feeInfo?.executionFee ?? 0n));
  console.log(
    "Total fees:",
    formatEther(fee.totalFeeInWei + (validation.data.feeInfo?.executionFee ?? 0n))
  );

  await submitAndReport({ ethWallet, transfer });

  await context.destroyContext();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
