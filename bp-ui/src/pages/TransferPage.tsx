import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress as isSubstrateAddress } from "@polkadot/util-crypto";
import { createPublicClient, http, type Address } from "viem";
import {
  getAcrossChains,
  getAcrossDestinations,
  getAcrossRoutesRaw,
  getAcrossTokensForChain,
} from "../catalog/acrossCatalog";
import {
  getSnowbridgeConfig,
  getSnowbridgeConfigs,
  getSnowbridgeAssetHubTokens,
  getSnowbridgeDestinations,
  getSnowbridgeProgressLabel,
  getSnowbridgeSourceDestinations,
  getSnowbridgeTokenSymbol,
  isSnowbridgeDestination,
  type SnowbridgeBridgeEnv,
} from "../catalog/snowbridgeCatalog";
import type { Chain, Env, Token } from "../catalog/types";
import ComboBox, { type ComboOption } from "../components/ComboBox";
import { executeAcrossViaSwapApi } from "../features/transfer/executors/acrossSwapExecutor";
import { executeSnowbridgeToAssetHub } from "../features/transfer/executors/snowbridgeExecutor";
import { executeSnowbridgeFromAssetHub } from "../features/transfer/executors/snowbridgeReverseExecutor";
import { buildTransferPlan } from "../features/transfer/planner";
import type { TransferIntent, TransferPlan } from "../features/transfer/types";
import { waitForDepositFill } from "../services/acrossDepositStatus";
import { fetchNonZeroBalances } from "../services/balanceLookup";
import { getRpcUrl } from "../evm/rpcs";

type Network = Env;

const isEvmAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

function isSubstrateRecipient(v: string): boolean {
  try {
    return isSubstrateAddress(v.trim());
  } catch {
    return false;
  }
}

type StepStatus = "idle" | "running" | "success" | "error";

type ProgressLine = {
  id: string;
  label: string;
  status: StepStatus;
  hash?: string;
  detail?: string;
};

type SubmitProgress = {
  started: boolean;
  lines: ProgressLine[];
  done: boolean;
  error?: string;
};

type MetricFee = {
  label: string;
  amount: string;
  unit: string;
};

type TransferMetrics = {
  endToEndMs: number;
  sourceConfirmationMs: number | null;
  destinationReceivedMs: number | null;
  successRate: string;
  totalFee: string;
  fees: MetricFee[];
  note?: string;
};

function StepBadge({ status }: { status: StepStatus }) {
  if (status === "running") return <span className="badge badge--spin" aria-label="running" />;
  if (status === "success") return <span className="badge badge--ok">OK</span>;
  if (status === "error") return <span className="badge badge--err">ERR</span>;
  return <span className="badge badge--idle">...</span>;
}

const emptyProgress = (): SubmitProgress => ({
  started: false,
  lines: [],
  done: false,
});

function buildProgressLines(plan: TransferPlan, env: Env): ProgressLine[] {
  const lines: ProgressLine[] = [];

  plan.steps.forEach((step, i) => {
    if (step.kind === "across") {
      if (step.tokenKey !== "native") {
        lines.push({
          id: `across-${i}-approve`,
          label: `Across approval (${i + 1})`,
          status: "idle",
        });
      }

      lines.push({
        id: `across-${i}-bridge`,
        label: `Across bridge tx (${i + 1})`,
        status: "idle",
      });

      if (step.recipientMode === "depositor") {
        lines.push({
          id: `across-${i}-wait-fill`,
          label: `Across fill for next step (${i + 1})`,
          status: "idle",
        });
      }
      return;
    }

    lines.push({
      id: `snowbridge-${i}-prepare`,
      label: `Prepare ${getSnowbridgeTokenSymbol(env, step.tokenKey, step.bridgeEnv)} for Snowbridge (${i + 1})`,
      status: "idle",
    });

    if (step.kind === "snowbridge" && step.tokenKey !== "native") {
      lines.push({
        id: `snowbridge-${i}-approve`,
        label: `Snowbridge approval (${i + 1})`,
        status: "idle",
      });
    }

    lines.push({
      id: `snowbridge-${i}-bridge`,
      label:
        step.kind === "snowbridgeReverse"
          ? `Snowbridge Asset Hub -> L1 (${i + 1})`
          : `${getSnowbridgeProgressLabel(step.originChainId, step.bridgeEnv)} (${i + 1})`,
      status: "idle",
    });

    if (step.kind === "snowbridgeReverse") {
      lines.push({
        id: `snowbridge-${i}-wait-l1`,
        label: `Wait for Snowbridge L1 arrival (${i + 1})`,
        status: "idle",
      });
    }

    if (step.kind === "snowbridge") {
      lines.push({
        id: `snowbridge-${i}-wait-destination`,
        label: `Wait for Asset Hub arrival (${i + 1})`,
        status: "idle",
      });
    }
  });

  return lines;
}

function shortenMiddle(text: string, head = 10, tail = 8): string {
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function tokenAddressFromKey(tokenKey: string, includeNative = false): Address | null {
  if (tokenKey === "native") return includeNative ? (ZERO_ADDRESS as Address) : null;

  const value = tokenKey.startsWith("erc20:") ? tokenKey.slice("erc20:".length) : "";
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as Address) : null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "not tracked";
  if (ms < 1000) return `${ms} ms`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function addFee(fees: MetricFee[], label: string, amount: string | undefined, unit: string) {
  if (!amount || amount === "0") return;
  fees.push({ label, amount, unit });
}

function positiveRawDiff(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b || !/^\d+$/.test(a) || !/^\d+$/.test(b)) return undefined;

  const diff = BigInt(a) - BigInt(b);
  return diff > 0n ? diff.toString() : undefined;
}

function totalFeeText(fees: MetricFee[]): string {
  if (fees.length === 0) return "not available";

  const totals = new Map<string, bigint>();
  const loose: string[] = [];

  for (const fee of fees) {
    if (/^\d+$/.test(fee.amount)) {
      totals.set(fee.unit, (totals.get(fee.unit) ?? 0n) + BigInt(fee.amount));
    } else {
      loose.push(`${fee.amount} ${fee.unit}`);
    }
  }

  return [
    ...Array.from(totals, ([unit, amount]) => `${amount.toString()} ${unit}`),
    ...loose,
  ].join(" + ");
}

async function requestEvmAccount(): Promise<Address> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("MetaMask not found");

  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const account = Array.isArray(accounts) ? accounts[0] : null;
  if (!isEvmAddress(String(account ?? ""))) throw new Error("No EVM account connected");

  return account as Address;
}

async function readL1TokenBalance(args: {
  chainId: number;
  tokenKey: string;
  account: Address;
}): Promise<bigint> {
  const rpcUrl = getRpcUrl(args.chainId);
  const publicClient = createPublicClient({
    chain: {
      id: args.chainId,
      name: `Chain ${args.chainId}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as any,
    transport: http(rpcUrl),
  });

  if (args.tokenKey === "native") {
    return publicClient.getBalance({ address: args.account });
  }

  const tokenAddress = tokenAddressFromKey(args.tokenKey);
  if (!tokenAddress) throw new Error("Invalid ERC20 token for L1 balance check.");

  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [args.account],
  }) as Promise<bigint>;
}

async function waitForL1BridgeCredit(args: {
  chainId: number;
  tokenKey: string;
  account: Address;
  baseline: bigint;
  amountRaw: string;
  onPoll?: (detail: string) => void;
}) {
  const expected = args.baseline + BigInt(args.amountRaw);
  const deadline = Date.now() + 90 * 60 * 1000;

  while (Date.now() < deadline) {
    const balance = await readL1TokenBalance({
      chainId: args.chainId,
      tokenKey: args.tokenKey,
      account: args.account,
    });

    if (balance >= expected) return balance;
    args.onPoll?.(`waiting for L1 balance ${balance.toString()} / ${expected.toString()}`);
    await new Promise((resolve) => window.setTimeout(resolve, 30 * 1000));
  }

  throw new Error("Timed out waiting for Snowbridge funds to arrive on L1.");
}

async function readAssetHubBridgeBalance(args: {
  env: Env;
  bridgeEnv?: SnowbridgeBridgeEnv;
  tokenKey: string;
  account: string;
}): Promise<bigint> {
  const tokenAddress = tokenAddressFromKey(args.tokenKey, true);
  if (!tokenAddress) throw new Error("Invalid Snowbridge token for Asset Hub balance check.");

  const config = getSnowbridgeConfig(args.env, args.bridgeEnv);
  const balances = await fetchNonZeroBalances({
    env: args.env,
    chain: config.destinationChain,
    walletAddress: args.account,
  });

  const target = tokenAddress.toLowerCase();
  return balances.find((balance) => balance.address?.toLowerCase() === target)?.rawAmount ?? 0n;
}

async function waitForAssetHubBridgeCredit(args: {
  env: Env;
  bridgeEnv?: SnowbridgeBridgeEnv;
  tokenKey: string;
  account: string;
  baseline: bigint;
  amountRaw: string;
  onPoll?: (detail: string) => void;
}) {
  const expected = args.baseline + BigInt(args.amountRaw);
  const deadline = Date.now() + 90 * 60 * 1000;

  while (Date.now() < deadline) {
    const balance = await readAssetHubBridgeBalance({
      env: args.env,
      bridgeEnv: args.bridgeEnv,
      tokenKey: args.tokenKey,
      account: args.account,
    });

    if (balance >= expected) return balance;
    args.onPoll?.(`waiting for Asset Hub balance ${balance.toString()} / ${expected.toString()}`);
    await new Promise((resolve) => window.setTimeout(resolve, 30 * 1000));
  }

  throw new Error("Timed out waiting for Snowbridge funds to arrive on Asset Hub.");
}

export default function TransferPage() {
  const [network, setNetwork] = useState<Network>("testnet");

  const [chains, setChains] = useState<Chain[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [destinations, setDestinations] = useState<Chain[]>([]);

  const [sourceChainId, setSourceChainId] = useState<number | null>(null);
  const [tokenKey, setTokenKey] = useState<string>("");
  const [destinationChainId, setDestinationChainId] = useState<number | null>(null);

  const [amount, setAmount] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");

  const [plan, setPlan] = useState<TransferPlan | null>(null);

  const [loadingChains, setLoadingChains] = useState(false);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exec, setExec] = useState<{ hash?: string; status?: string; err?: string }>({});
  const [execLoading, setExecLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const [progress, setProgress] = useState<SubmitProgress>(emptyProgress());
  const [metrics, setMetrics] = useState<TransferMetrics | null>(null);

  const chainOptions: ComboOption<number>[] = useMemo(
    () =>
      chains.map((c) => ({
        value: c.chainId,
        label: c.name,
        subLabel: c.type === "substrate" ? "Parachain 1000" : String(c.chainId),
      })),
    [chains]
  );

  const tokenOptions: ComboOption<string>[] = useMemo(
    () =>
      tokens.map((t) => ({
        value: t.key,
        label: t.symbol,
        subLabel: t.isNative
          ? "Native"
          : t.address
            ? `${t.address.slice(0, 6)}...${t.address.slice(-4)}`
            : "",
      })),
    [tokens]
  );

  const destinationOptions: ComboOption<number>[] = useMemo(
    () =>
      destinations.map((c) => ({
        value: c.chainId,
        label: c.name,
        subLabel: c.type === "substrate" ? "Parachain 1000" : String(c.chainId),
      })),
    [destinations]
  );

  const selectedToken = useMemo(() => tokens.find((t) => t.key === tokenKey) ?? null, [tokens, tokenKey]);
  const snowbridgeConfigs = useMemo(() => getSnowbridgeConfigs(network), [network]);

  const recipientIsSubstrate = useMemo(
    () => destinationChainId != null && isSnowbridgeDestination(destinationChainId),
    [destinationChainId]
  );

  const recipientValid = useMemo(() => {
    const value = recipient.trim();
    if (!value) return false;
    return recipientIsSubstrate ? isSubstrateRecipient(value) : isEvmAddress(value);
  }, [recipient, recipientIsSubstrate]);

  const canSubmit = useMemo(
    () =>
      sourceChainId != null &&
      tokenKey.length > 0 &&
      destinationChainId != null &&
      amount.trim().length > 0 &&
      recipientValid,
    [sourceChainId, tokenKey, destinationChainId, amount, recipientValid]
  );

  const chainNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of chains) m.set(c.chainId, c.name);
    for (const c of destinations) m.set(c.chainId, c.name);
    for (const config of snowbridgeConfigs) {
      m.set(config.destinationChain.chainId, config.destinationChain.name);
      m.set(config.assetHubParaId, config.destinationChain.name);
    }
    return m;
  }, [chains, destinations, snowbridgeConfigs]);

  const recipientLabel = recipientIsSubstrate ? "Recipient (Substrate SS58)" : "Recipient (EVM)";

  const recipientPlaceholder = recipientIsSubstrate ? "12..." : "0x...";

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);

      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1400);
    } catch {
      setError("Copy failed");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);
      setLoadingChains(true);

      setChains([]);
      setTokens([]);
      setDestinations([]);
      setSourceChainId(null);
      setTokenKey("");
      setDestinationChainId(null);
      setAmount("");
      setRecipient("");
      setPlan(null);
      setExec({});
      setProgress(emptyProgress());
      setMetrics(null);

      try {
        const list = await getAcrossChains(network);
        if (cancelled) return;

        const merged = new Map<number, Chain>();
        for (const chain of list) merged.set(chain.chainId, chain);
        for (const config of snowbridgeConfigs) {
          merged.set(config.destinationChain.chainId, config.destinationChain);
        }

        const sourceChains = Array.from(merged.values()).sort((a, b) => a.chainId - b.chainId);
        setChains(sourceChains);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load chains");
      } finally {
        if (!cancelled) setLoadingChains(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [network, snowbridgeConfigs]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);
      setTokens([]);
      setDestinations([]);
      setTokenKey("");
      setDestinationChainId(null);
      setPlan(null);
      setExec({});
      setProgress(emptyProgress());
      setMetrics(null);

      if (sourceChainId == null) return;

      setLoadingTokens(true);
      try {
        const list = isSnowbridgeDestination(sourceChainId)
          ? getSnowbridgeAssetHubTokens(network, sourceChainId)
          : await getAcrossTokensForChain(network, sourceChainId);
        if (cancelled) return;

        list.sort((a, b) => {
          if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
          return a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key);
        });

        setTokens(list);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load tokens");
      } finally {
        if (!cancelled) setLoadingTokens(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [network, sourceChainId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);
      setDestinations([]);
      setDestinationChainId(null);
      setPlan(null);
      setExec({});
      setProgress(emptyProgress());
      setMetrics(null);

      if (sourceChainId == null) return;
      if (!tokenKey) return;

      setLoadingDestinations(true);
      try {
        if (isSnowbridgeDestination(sourceChainId)) {
          const snowbridgeDestinations = getSnowbridgeSourceDestinations({
            env: network,
            sourceChainId,
            tokenKey,
            chains,
            routes: await getAcrossRoutesRaw(network),
          });

          if (!cancelled) {
            if (network === "testnet" && snowbridgeDestinations.length === 0) {
              setError(
                "This Asset Hub source currently has no supported Snowbridge destination for the selected token."
              );
            }
            setDestinations(snowbridgeDestinations.sort((a, b) => a.chainId - b.chainId));
          }
          return;
        }

        const [acrossDestinations, routes] = await Promise.all([
          getAcrossDestinations(network, sourceChainId, tokenKey),
          getAcrossRoutesRaw(network),
        ]);

        if (cancelled) return;

        const snowbridgeDestinations = getSnowbridgeDestinations({
          env: network,
          originChainId: sourceChainId,
          tokenKey,
          routes,
        });

        const merged = new Map<number, Chain>();
        for (const chain of acrossDestinations) merged.set(chain.chainId, chain);
        for (const chain of snowbridgeDestinations) merged.set(chain.chainId, chain);

        setDestinations(Array.from(merged.values()).sort((a, b) => a.chainId - b.chainId));
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load destinations");
      } finally {
        if (!cancelled) setLoadingDestinations(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [chains, network, sourceChainId, tokenKey]);

  function updateProgressLine(id: string, patch: Partial<ProgressLine>) {
    setProgress((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    }));
  }

  async function onSubmitPreview() {
    setError(null);
    setExec({});
    setProgress(emptyProgress());
    setMetrics(null);

    if (sourceChainId == null || destinationChainId == null || !tokenKey) return;

    if (!recipientValid) {
      alert(recipientIsSubstrate ? "Invalid Substrate recipient address" : "Invalid EVM recipient address");
      return;
    }

    const intent: TransferIntent = {
      env: network,
      originChainId: sourceChainId,
      destinationChainId,
      tokenKey,
      amount,
      recipient: recipient.trim(),
    };

    try {
      const routes = await getAcrossRoutesRaw(network);
      const built = buildTransferPlan(intent, { routes });
      setPlan(built);
    } catch (e: any) {
      setPlan(null);
      setError(e?.message ?? "Failed to build plan");
    }
  }

  async function onSubmit() {
    if (!plan) return;
    if (!canSubmit) return;

    setExecLoading(true);
    setExec({});
    setError(null);
    setMetrics(null);
    setProgress({
      started: true,
      lines: buildProgressLines(plan, network),
      done: false,
    });

    let snowbridgeAmountRawFromAcross: string | undefined;
    let activeProgressLineId: string | null = null;
    let requiredAcrossAccount: Address | undefined;
    let sourceConfirmationMs = 0;
    let destinationReceivedAt: number | null = null;
    let metricNote: string | undefined;
    const transferStartedAt = performance.now();
    const fees: MetricFee[] = [];

    const finishMetrics = (success: boolean) => {
      setMetrics({
        endToEndMs: Math.round(performance.now() - transferStartedAt),
        sourceConfirmationMs: sourceConfirmationMs > 0 ? sourceConfirmationMs : null,
        destinationReceivedMs:
          destinationReceivedAt !== null ? Math.round(destinationReceivedAt - transferStartedAt) : null,
        successRate: success ? "1/1 (100%)" : "0/1 (0%)",
        totalFee: totalFeeText(fees),
        fees: [...fees],
        note: metricNote,
      });
    };

    try {
      const needsAcross = plan.steps.some((step) => step.kind === "across");
      const routes = needsAcross ? await getAcrossRoutesRaw(network) : [];

      for (let i = 0; i < plan.steps.length; i += 1) {
        const step = plan.steps[i];

        if (step.kind === "across") {
          const approvalLineId = `across-${i}-approve`;
          const bridgeLineId = `across-${i}-bridge`;
          const needsApproval = step.tokenKey !== "native";

          if (needsApproval) {
            activeProgressLineId = approvalLineId;
            updateProgressLine(approvalLineId, { status: "running", detail: undefined });
          }

          activeProgressLineId = bridgeLineId;
          updateProgressLine(bridgeLineId, { status: "running", detail: undefined });

          const acrossRecipient =
            step.recipientMode === "final" ? (recipient.trim() as `0x${string}`) : undefined;

          const res = await executeAcrossViaSwapApi({
            env: network,
            originChainId: step.originChainId,
            destinationChainId: step.destinationChainId,
            tokenKey: step.tokenKey,
            amountHuman: amount,
            recipient: acrossRecipient,
            routes,
            tokens,
            expectedAccount: requiredAcrossAccount,
          });
          sourceConfirmationMs += res.sourceConfirmationMs ?? 0;
          addFee(fees, "Across approval gas", res.approvalGasFeeWei, "wei");
          addFee(fees, "Across swap gas", res.swapGasFeeWei, "wei");
          addFee(
            fees,
            "Across relay fee",
            positiveRawDiff(res.inputAmountRaw, res.expectedOutputAmount),
            `raw ${selectedToken?.symbol ?? "token"}`
          );

          if (needsApproval) {
            updateProgressLine(approvalLineId, {
              status: "success",
              hash: res.approvalTxHash ?? undefined,
            });
          }

          const bridgeOk = res.swapReceiptStatus === "success";
          updateProgressLine(bridgeLineId, {
            status: bridgeOk ? "success" : "error",
            hash: res.swapTxHash,
          });

          if (!bridgeOk) {
            throw new Error("Across bridge transaction reverted.");
          }

          if (step.recipientMode === "depositor") {
            const waitLineId = `across-${i}-wait-fill`;
            activeProgressLineId = waitLineId;
            updateProgressLine(waitLineId, { status: "running", hash: res.swapTxHash });

            const fill = await waitForDepositFill({
              env: network,
              depositTxnRef: res.swapTxHash,
              timeoutMs: 45 * 60 * 1000,
              pollIntervalMs: 20 * 1000,
              onPoll: (status) => updateProgressLine(waitLineId, { detail: status || "pending" }),
            });

            const fillStatusText =
              typeof fill.status === "string"
                ? fill.status
                : typeof fill.depositStatus === "string"
                  ? fill.depositStatus
                  : "filled";

            updateProgressLine(waitLineId, {
              status: "success",
              hash: res.swapTxHash,
              detail: fillStatusText,
            });

            if (i === plan.steps.length - 1) {
              destinationReceivedAt = performance.now();
            }

            snowbridgeAmountRawFromAcross = res.minOutputAmount ?? res.expectedOutputAmount;
            if (!snowbridgeAmountRawFromAcross || snowbridgeAmountRawFromAcross === "0") {
              throw new Error("Across quote did not return destination output amount for Snowbridge step.");
            }
          }

          continue;
        }

        const snowbridgePrepareLineId = `snowbridge-${i}-prepare`;
        const snowbridgeApproveLineId = `snowbridge-${i}-approve`;
        const snowbridgeLineId = `snowbridge-${i}-bridge`;
        const snowbridgeWaitLineId = `snowbridge-${i}-wait-l1`;
        const snowbridgeDestinationLineId = `snowbridge-${i}-wait-destination`;
        activeProgressLineId = snowbridgePrepareLineId;

        if (step.kind === "snowbridgeReverse") {
          const l1Recipient =
            step.recipientMode === "depositor" ? await requestEvmAccount() : (recipient.trim() as Address);
          let l1BalanceBefore: bigint | undefined;
          let l1WatchError: string | undefined;

          try {
            l1BalanceBefore = await readL1TokenBalance({
              chainId: step.destinationChainId,
              tokenKey: step.tokenKey,
              account: l1Recipient,
            });
          } catch (e: any) {
            if (step.recipientMode === "depositor") throw e;
            l1WatchError = e?.message ?? "L1 balance watcher unavailable.";
          }

          const res = await executeSnowbridgeFromAssetHub({
            env: network,
            destinationChainId: step.destinationChainId,
            bridgeEnv: step.bridgeEnv,
            recipientEvm: l1Recipient,
            tokenKey: step.tokenKey,
            tokenDecimals: selectedToken?.decimals,
            amountHuman: amount,
            onProgress: (event) => {
              const lineId = event.stage === "prepare" ? snowbridgePrepareLineId : snowbridgeLineId;
              activeProgressLineId = lineId;
              updateProgressLine(lineId, {
                status: event.status,
                hash: event.hash,
                detail: event.detail,
              });
            },
          });
          sourceConfirmationMs += res.sourceConfirmationMs ?? 0;
          addFee(fees, "Snowbridge delivery", res.deliveryFeeDot, "DOT");

          const ok = res.status === "success";
          updateProgressLine(snowbridgeLineId, {
            status: ok ? "success" : "error",
            hash: res.txHash,
            detail: `asset=${res.bridgeAssetSymbol}, deliveryFeeDOT=${res.deliveryFeeDot}`,
          });

          if (!ok) {
            throw new Error("Snowbridge transaction reverted.");
          }

          setExec({ hash: res.txHash, status: res.status });

          if (step.recipientMode === "depositor") {
            requiredAcrossAccount = l1Recipient;
          }

          if (l1BalanceBefore !== undefined) {
            activeProgressLineId = snowbridgeWaitLineId;
            updateProgressLine(snowbridgeWaitLineId, {
              status: "running",
              detail: `Waiting for ${res.bridgeAssetSymbol} on L1 account ${shortenMiddle(l1Recipient)}.`,
            });

            await waitForL1BridgeCredit({
              chainId: step.destinationChainId,
              tokenKey: step.tokenKey,
              account: l1Recipient,
              baseline: l1BalanceBefore,
              amountRaw: res.amountRaw,
              onPoll: (detail) => updateProgressLine(snowbridgeWaitLineId, { detail }),
            });

            updateProgressLine(snowbridgeWaitLineId, {
              status: "success",
              detail: `${res.bridgeAssetSymbol} arrived on L1.`,
            });

            if (i === plan.steps.length - 1) {
              destinationReceivedAt = performance.now();
            }
          } else {
            const note = l1WatchError ? `destination_received_time not tracked: ${l1WatchError}` : undefined;
            metricNote = note ?? metricNote;
            updateProgressLine(snowbridgeWaitLineId, {
              status: "success",
              detail: note,
            });
          }

          continue;
        }

        const amountRaw =
          step.amountSource === "acrossMinOutput" ? snowbridgeAmountRawFromAcross : undefined;

        if (step.amountSource === "acrossMinOutput" && !amountRaw) {
          throw new Error("Missing Across output amount for Snowbridge step.");
        }

        let assetHubBalanceBefore: bigint | undefined;
        let assetHubWatchError: string | undefined;
        try {
          assetHubBalanceBefore = await readAssetHubBridgeBalance({
            env: network,
            bridgeEnv: step.bridgeEnv,
            tokenKey: step.tokenKey,
            account: recipient.trim(),
          });
        } catch (e: any) {
          assetHubWatchError = e?.message ?? "Asset Hub balance watcher unavailable.";
        }

        const res = await executeSnowbridgeToAssetHub({
          env: network,
          recipientSubstrate: recipient.trim(),
          tokenKey: step.tokenKey,
          bridgeEnv: step.bridgeEnv,
          tokenDecimals: selectedToken?.decimals,
          amountHuman: step.amountSource === "input" ? amount : undefined,
          amountRaw,
          onProgress: (event) => {
            const lineId =
              event.stage === "prepare"
                ? snowbridgePrepareLineId
                : event.stage === "approve"
                  ? snowbridgeApproveLineId
                  : snowbridgeLineId;

            activeProgressLineId = lineId;
            updateProgressLine(lineId, {
              status: event.status,
              hash: event.hash,
              detail: event.detail,
            });
          },
        });
        sourceConfirmationMs += res.sourceConfirmationMs ?? 0;
        addFee(fees, "Snowbridge approval gas", res.approvalGasFeeWei, "wei");
        addFee(fees, "Snowbridge bridge gas", res.bridgeGasFeeWei, "wei");
        addFee(fees, "Snowbridge delivery", res.deliveryFeeWei, "wei");

        const ok = res.status === "success";
        updateProgressLine(snowbridgeLineId, {
          status: ok ? "success" : "error",
          hash: res.txHash,
          detail: `asset=${res.bridgeAssetSymbol}, deliveryFee=${res.deliveryFeeWei}`,
        });

        if (!ok) {
          throw new Error("Snowbridge transaction reverted.");
        }

        setExec({ hash: res.txHash, status: res.status });

        if (assetHubBalanceBefore !== undefined) {
          activeProgressLineId = snowbridgeDestinationLineId;
          updateProgressLine(snowbridgeDestinationLineId, {
            status: "running",
            detail: `Waiting for ${res.bridgeAssetSymbol} on Asset Hub.`,
          });

          await waitForAssetHubBridgeCredit({
            env: network,
            bridgeEnv: step.bridgeEnv,
            tokenKey: step.tokenKey,
            account: recipient.trim(),
            baseline: assetHubBalanceBefore,
            amountRaw: res.amountRaw,
            onPoll: (detail) => updateProgressLine(snowbridgeDestinationLineId, { detail }),
          });

          updateProgressLine(snowbridgeDestinationLineId, {
            status: "success",
            detail: `${res.bridgeAssetSymbol} arrived on Asset Hub.`,
          });

          if (i === plan.steps.length - 1) {
            destinationReceivedAt = performance.now();
          }
        } else {
          const note = assetHubWatchError
            ? `destination_received_time not tracked: ${assetHubWatchError}`
            : undefined;
          metricNote = note ?? metricNote;
          updateProgressLine(snowbridgeDestinationLineId, {
            status: "success",
            detail: note,
          });
        }
      }

      finishMetrics(true);
      setProgress((prev) => ({ ...prev, done: true }));
    } catch (e: any) {
      const msg = e?.message ?? "Execution failed";
      finishMetrics(false);
      setExec({ err: msg });
      setError(msg);
      setProgress((prev) => ({
        ...prev,
        lines: prev.lines.map((line) =>
          line.status === "running" || line.id === activeProgressLineId
            ? {
                ...line,
                status: "error",
                detail: line.id === activeProgressLineId ? msg : line.detail,
              }
            : line
        ),
        done: false,
        error: msg,
      }));
    } finally {
      setExecLoading(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div className="panel__title">Transfer</div>

        <div className="networkSwitch">
          <button
            type="button"
            className={`networkBtn ${network === "mainnet" ? "active" : ""}`}
            onClick={() => setNetwork("mainnet")}
          >
            Mainnet
          </button>

          <button
            type="button"
            className={`networkBtn ${network === "testnet" ? "active" : ""}`}
            onClick={() => setNetwork("testnet")}
          >
            Testnet
          </button>
        </div>
      </div>

      {error ? (
        <div className="muted errorText" style={{ marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <ComboBox
          label="Source chain"
          placeholder="Type or pick source chain..."
          value={sourceChainId}
          onChange={(v) => setSourceChainId(v)}
          options={chainOptions}
          loading={loadingChains}
          disabled={loadingChains || execLoading}
        />

        <div className="row2">
          <ComboBox
            label="Token"
            placeholder={sourceChainId == null ? "Select source chain first" : "Type or pick token..."}
            value={tokenKey || null}
            onChange={(v) => setTokenKey(v ?? "")}
            options={tokenOptions}
            loading={loadingTokens}
            disabled={sourceChainId == null || loadingTokens || execLoading}
          />

          <div>
            <label className="label">Amount</label>
            <input
              className="control"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={execLoading}
            />
          </div>
        </div>

        <ComboBox
          label="Destination chain"
          placeholder={
            sourceChainId == null
              ? "Select source chain first"
              : !tokenKey
                ? "Select token first"
                : "Type or pick destination chain..."
          }
          value={destinationChainId}
          onChange={(v) => setDestinationChainId(v)}
          options={destinationOptions}
          loading={loadingDestinations}
          disabled={sourceChainId == null || !tokenKey || loadingDestinations || execLoading}
        />

        <div>
          <label className="label">{recipientLabel}</label>
          <input
            className="control"
            placeholder={recipientPlaceholder}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={execLoading}
          />
        </div>

        <div className="row2" style={{ alignItems: "end" }}>
          <button
            type="button"
            className="submitBtn"
            disabled={!canSubmit || execLoading}
            onClick={onSubmitPreview}
          >
            Preview
          </button>

          <button
            type="button"
            className="submitBtn"
            disabled={!plan || !canSubmit || execLoading}
            onClick={onSubmit}
          >
            {execLoading ? "Submitting..." : "Submit"}
          </button>
        </div>

        {plan && (
          <div className="previewCard">
            <div className="previewTitle">Transfer Preview</div>

            <div className="previewRow">
              <strong>Token:</strong>{" "}
              {selectedToken ? (
                selectedToken.isNative ? (
                  `${selectedToken.symbol} (native)`
                ) : (
                  `${selectedToken.symbol} (${selectedToken.address?.slice(0, 6)}...${selectedToken.address?.slice(-4)})`
                )
              ) : (
                tokenKey
              )}
            </div>

            <div className="previewRow">
              <strong>Amount:</strong> {amount}
            </div>

            <div className="previewRow">
              <strong>Recipient:</strong> {recipient.trim()}
            </div>

            <div className="previewRow" style={{ marginTop: 10 }}>
              <strong>Steps:</strong> {plan.steps.length}
            </div>

            {plan.steps.map((step, i) => (
              <div key={i} className="previewStep">
                <div className="previewStepTitle">{step.kind === "across" ? "Across" : "Snowbridge"}</div>

                <div className="previewFlow">
                  {step.kind === "snowbridgeReverse"
                    ? (snowbridgeConfigs.find((config) => config.bridgeEnv === step.bridgeEnv)?.destinationName ??
                      chainNameById.get(step.originParaId) ??
                      step.originParaId)
                    : (chainNameById.get(step.originChainId) ?? step.originChainId)}
                  <span className="arrow">-&gt;</span>
                  {step.kind === "across"
                    ? (chainNameById.get(step.destinationChainId) ?? step.destinationChainId)
                    : step.kind === "snowbridgeReverse"
                      ? (chainNameById.get(step.destinationChainId) ?? step.destinationChainId)
                      : (snowbridgeConfigs.find((config) => config.bridgeEnv === step.bridgeEnv)?.destinationName ??
                        chainNameById.get(step.destinationParaId) ??
                        step.destinationParaId)}
                </div>

                <div className="muted">Wallet required: {step.requiredWallet}</div>
                {step.kind !== "across" ? (
                  <div className="muted">{getSnowbridgeTokenSymbol(network, step.tokenKey, step.bridgeEnv)} is sent through Snowbridge.</div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {progress.started && (
          <div className="previewCard" style={{ marginTop: 14 }}>
            <div className="previewTitle">Submit progress</div>

            {progress.lines.map((line) => (
              <div key={line.id} className="progressRow">
                <StepBadge status={line.status} />
                <div className="progressContent">
                  <div className="progressText">{line.label}</div>
                  {line.detail || line.hash ? (
                    <div className="progressMeta">
                      {line.detail ? <div className="muted progressDetail">{line.detail}</div> : null}
                      {line.hash ? (
                        <div className="copyLine">
                          <div className="muted copyValue" title={line.hash}>
                            {shortenMiddle(line.hash)}
                          </div>
                          <button
                            type="button"
                            className="copyBtn"
                            onClick={() => copyText(`progress-${line.id}`, line.hash!)}
                            aria-label="Copy tx hash"
                            title="Copy tx hash"
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                              <rect x="5" y="1.5" width="9.5" height="11" rx="1.5" fill="none" stroke="currentColor" />
                              <rect x="1.5" y="4.5" width="9.5" height="10" rx="1.5" fill="none" stroke="currentColor" />
                            </svg>
                          </button>
                          {copiedKey === `progress-${line.id}` ? (
                            <div className="copyStatus">tx hash copied</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            <div className="progressSummary">
              {progress.done ? <div className="muted">Completed</div> : null}
              {progress.error ? <div className="muted errorText">{progress.error}</div> : null}

              {exec.err && exec.err !== progress.error ? <div className="muted errorText">{exec.err}</div> : null}
              {exec.hash ? (
                <div className="copyLine">
                  <div className="muted copyValue" title={exec.hash}>Tx: {shortenMiddle(exec.hash)}</div>
                  <button
                    type="button"
                    className="copyBtn"
                    onClick={() => copyText("exec-hash", exec.hash!)}
                    aria-label="Copy tx hash"
                    title="Copy tx hash"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <rect x="5" y="1.5" width="9.5" height="11" rx="1.5" fill="none" stroke="currentColor" />
                      <rect x="1.5" y="4.5" width="9.5" height="10" rx="1.5" fill="none" stroke="currentColor" />
                    </svg>
                  </button>
                  {copiedKey === "exec-hash" ? <div className="copyStatus">tx hash copied</div> : null}
                </div>
              ) : null}
              {exec.status ? <div className="muted">Status: {exec.status}</div> : null}
            </div>

            {metrics ? (
              <div className="metricsBlock">
                <div className="previewTitle">Metrics</div>
                <div className="metricRow">
                  <span>end_to_end_time</span>
                  <strong>{formatDuration(metrics.endToEndMs)}</strong>
                </div>
                <div className="metricRow">
                  <span>source_confirmation_time</span>
                  <strong>{formatDuration(metrics.sourceConfirmationMs)}</strong>
                </div>
                <div className="metricRow">
                  <span>destination_received_time</span>
                  <strong>{formatDuration(metrics.destinationReceivedMs)}</strong>
                </div>
                <div className="metricRow">
                  <span>success_rate</span>
                  <strong>{metrics.successRate}</strong>
                </div>
                <div className="metricRow">
                  <span>total_fee</span>
                  <strong>{metrics.totalFee}</strong>
                </div>
                {metrics.fees.length > 0 ? (
                  <div className="metricBreakdown">
                    {metrics.fees.map((fee, index) => (
                      <div key={`${fee.label}-${fee.unit}-${index}`} className="muted">
                        {fee.label}: {fee.amount} {fee.unit}
                      </div>
                    ))}
                  </div>
                ) : null}
                {metrics.note ? <div className="muted metricNote">{metrics.note}</div> : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {loadingChains || loadingTokens || loadingDestinations
            ? "Fetching catalog..."
            : canSubmit
              ? `Ready: ${sourceChainId} -> ${destinationChainId}`
              : "Pick source, token, destination, amount, recipient."}
        </div>
      </form>
    </section>
  );
}
