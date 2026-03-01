import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ====== KONFIG ======
const RPC_URL = "https://sepolia.base.org";
const CHAIN_ID = 84532;

// Base (OP Stack) WETH address (WETH = ERC20 wrapper for native ETH)
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;

// 1) Najbezpečnejšie: nastav PRIVATE_KEY cez env (odporúčané)
// 2) Alternatíva: vlož si ho sem (NEODPORÚČAM, ale chcel si “len vložiť”)
const PRIVATE_KEY_INLINE: `0x${string}` | "" = ""; // napr. "0xabc..."; nechaj "" ak používaš env

// ====== ABI ======
const WETH_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

function getPrivateKey(): `0x${string}` {
  const fromEnv = "PRIVATE KEY";
  const pk = (fromEnv && fromEnv !== "") ? fromEnv : PRIVATE_KEY_INLINE;

  if (!pk || pk === "") {
    throw new Error(
      "PRIVATE_KEY missing. Set env PRIVATE_KEY or fill PRIVATE_KEY_INLINE in the script."
    );
  }
  if (!pk.startsWith("0x") || pk.length !== 66) {
    throw new Error(
      "PRIVATE_KEY must be 32-byte hex string like 0x... (length 66)."
    );
  }
  return pk as `0x${string}`;
}

async function main() {
  console.log("=== Base Sepolia WETH -> ETH (UNWRAP ALL) ===");
  console.log("RPC:", RPC_URL);
  console.log("chainId:", CHAIN_ID);
  console.log("WETH:", WETH_ADDRESS);
  console.log("------------------------------------------");

  const pk = getPrivateKey();
  console.log("Private key loaded (not printing it). ✅");

  const account = privateKeyToAccount(pk);
  console.log("Account:", account.address);

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });

  // ETH balance (native)
  const ethBefore = await publicClient.getBalance({ address: account.address });
  console.log("ETH balance before:", formatEther(ethBefore));

  // WETH balance (erc20)
  const wethBefore = await publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log("WETH balance before (raw):", wethBefore.toString());
  console.log("WETH balance before:", formatEther(wethBefore));

  if (wethBefore === 0n) {
    console.log("Nothing to unwrap. Done.");
    return;
  }

  console.log("------------------------------------------");
  console.log("Estimating gas for withdraw(all) ...");

  const gas = await publicClient.estimateContractGas({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "withdraw",
    args: [wethBefore],
    account: account.address,
  });

  console.log("Estimated gas:", gas.toString());
  console.log("Sending withdraw tx...");

  const hash = await walletClient.writeContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "withdraw",
    args: [wethBefore],
    gas,
  });

  console.log("TX hash:", hash);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log("Receipt status:", receipt.status);
  console.log("------------------------------------------");

  const ethAfter = await publicClient.getBalance({ address: account.address });
  const wethAfter = await publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  console.log("ETH balance after:", formatEther(ethAfter));
  console.log("WETH balance after (raw):", wethAfter.toString());
  console.log("WETH balance after:", formatEther(wethAfter));
  console.log("=== DONE ===");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});