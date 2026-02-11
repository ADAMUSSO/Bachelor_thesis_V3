// WebSocket polyfill for Node (polkadot-api)
import WebSocket from "ws";
(globalThis as any).WebSocket = WebSocket;

import "dotenv/config";

import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";
import { getPolkadotSigner } from "polkadot-api/signer";
import { setTimeout as sleep } from "timers/promises";

import {
  Builder,
  Foreign,
  hasDryRunSupport,
  // These exist in many ParaSpell versions; if missing, fallback will be used.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAllAssetsSymbols,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  CHAINS,
} from "@paraspell/sdk";

import { ENV } from "../shared/env.js";

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */

const FROM_CHAIN = "AssetHubPaseo";

// Asset to scan
const SYMBOL = "WETH";
const SYMBOL_FOR_BUILDER = Foreign(SYMBOL);

// Amount must be >= ED on destination for many assets, otherwise you get misleading failures.
// Use something comfortably above typical ED (you can tune later).
const AMOUNT = 20_000_000_000_000n;

// Slow down between dry-runs to reduce WS flakiness on public RPC endpoints
const BETWEEN_MS = 800;

// If getAllChains() is missing in your ParaSpell build, we fall back to this list.
// Add/remove as you like.
const FALLBACK_PASEO_DESTINATIONS: string[] = [
  "BifrostPaseo",
  "AssetHubPaseo", // sanity (should usually be OK as local)
  "HydraDXPaseo",
  "MoonbeamPaseo",
  "AstarPaseo",
  "InterlayPaseo",
  "MantaPaseo",
];

/* -------------------------------------------------------------------------- */
/*                                  SIGNER                                    */
/* -------------------------------------------------------------------------- */

async function initSigner() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromUri(ENV.substrateKey);

  const signer = getPolkadotSigner(pair.publicKey, "Sr25519", (msg: Uint8Array) =>
    pair.sign(msg)
  );

  return { signer, address: pair.address };
}

/* -------------------------------------------------------------------------- */
/*                                  SCANNER                                   */
/* -------------------------------------------------------------------------- */

type ScanResult = {
  to: string;
  ok: boolean;
  // If not ok, show reasons (best-effort from dry-run shape)
  chain?: string;
  reason?: string;
  subReason?: string;
};

function pickFailureInfo(dry: any): { chain?: string; reason?: string; subReason?: string } {
  // ParaSpell dry-run objects vary slightly; handle both common layouts
  const chain = dry?.failureChain ?? (dry?.destination?.success === false ? "destination" : "origin");
  const reason =
    dry?.failureReason ??
    dry?.destination?.failureReason ??
    dry?.origin?.failureReason ??
    "Unknown";
  const subReason =
    dry?.failureSubReason ??
    dry?.destination?.failureSubReason ??
    dry?.origin?.failureSubReason ??
    undefined;
  return { chain, reason, subReason };
}

async function getCandidateDestinations(): Promise<string[]> {
  // Try to use ParaSpell registry if available.
  try {
    // @ts-expect-error: getAllChains might not exist in some builds
    const all = typeof getAllChains === "function" ? (getAllChains() as string[]) : null;
    if (Array.isArray(all) && all.length) {
      // Narrow to Paseo destinations (heuristic: name contains "Paseo" and not equal to FROM)
      const paseo = all.filter((c) => c.includes("Paseo") && c !== FROM_CHAIN);
      if (paseo.length) return paseo;
    }
  } catch {
    // ignore, fallback below
  }

  return FALLBACK_PASEO_DESTINATIONS.filter((c) => c !== FROM_CHAIN);
}

async function dryRunOne(to: string, sender: string): Promise<ScanResult> {
  // quick gate: if chain doesn't support dry-run, we still try (some versions lie), but mark it
  const dryRunSupported = hasDryRunSupport(FROM_CHAIN);

  try {
    if (!dryRunSupported) {
      return {
        to,
        ok: false,
        chain: "origin",
        reason: "DryRunNotSupportedOnOrigin",
        subReason: undefined,
      };
    }

    const dry = await Builder()
      .from(FROM_CHAIN)
      .to("BifrostPaseo")
      .currency({ symbol: SYMBOL_FOR_BUILDER, amount: AMOUNT })
      .senderAddress(sender)
      .address(sender)
      .dryRun();

    // Many dry-runs encode success either as top-level success OR by absence of failureChain.
    const ok =
      (dry?.origin?.success === true && (dry?.destination?.success ?? true) === true) ||
      (dry?.failureReason == null && dry?.failureChain == null);

    if (ok) {
      return { to, ok: true };
    }

    const info = pickFailureInfo(dry);
    return { to, ok: false, ...info };
  } catch (e: any) {
    // Connection errors or unexpected runtime exceptions
    const msg = String(e?.message ?? e);
    return {
      to,
      ok: false,
      chain: "runtime",
      reason: msg.includes("Unable to connect") ? "RpcConnectionFailed" : "DryRunException",
      subReason: msg.slice(0, 160),
    };
  }
}

async function scanWethRoutes() {
  const { address: sender } = await initSigner();

  console.log("Scanning routes for:", SYMBOL);
  console.log("From:", FROM_CHAIN);
  console.log("Sender:", sender);
  console.log("Amount:", AMOUNT.toString());
  console.log("--------------------------------------------------");

  const destinations = await getCandidateDestinations();

  // Optional: filter to only chains that *mention* WETH in supported assets list (best-effort).
  // If getAllAssetsSymbols isn't available, we skip filtering.
  let filtered = destinations;
  try {
    // -expect-error: getAllAssetsSymbols might not exist in some builds
    if (typeof getAllAssetsSymbols === "function") {
      const keep: string[] = [];
      for (const to of destinations) {
        try {
          // @ts-expect-error
          const syms = getAllAssetsSymbols(to) as string[];
          if (Array.isArray(syms) && syms.includes("WETH")) keep.push(to);
        } catch {
          // if we can't query, keep it anyway (dry-run will tell)
          keep.push(to);
        }
      }
      filtered = keep;
    }
  } catch {
    // ignore
  }

  const results: ScanResult[] = [];

  for (const to of filtered) {
    process.stdout.write(`• ${FROM_CHAIN} -> ${to} ... `);
    const r = await dryRunOne(to, sender);

    if (r.ok) {
      console.log("OK ✅");
    } else {
      const detail = [r.chain, r.reason, r.subReason].filter(Boolean).join(" / ");
      console.log(`NO ❌ (${detail})`);
    }

    results.push(r);
    await sleep(BETWEEN_MS);
  }

  console.log("--------------------------------------------------");

  const ok = results.filter((r) => r.ok).map((r) => r.to);
  const no = results.filter((r) => !r.ok);

  console.log("✅ WORKING destinations:");
  if (ok.length) ok.forEach((c) => console.log("  -", c));
  else console.log("  (none found)");

  console.log("\n❌ NOT WORKING destinations (top reasons):");
  const counts = new Map<string, number>();
  for (const r of no) {
    const key = `${r.chain ?? "?"}:${r.reason ?? "Unknown"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`  - ${k}  x${v}`));
}

/* -------------------------------------------------------------------------- */
/*                                    MAIN                                    */
/* -------------------------------------------------------------------------- */

scanWethRoutes().catch((e) => {
  console.error(e);
  process.exit(1);
});
