import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress as isSubstrateAddress } from "@polkadot/util-crypto";
import {
  getAcrossChains,
  getAcrossDestinations,
  getAcrossRoutesRaw,
  getAcrossTokensForChain,
} from "../catalog/acrossCatalog";
import {
  getSnowbridgeConfig,
  getSnowbridgeDestinations,
  getSnowbridgeProgressLabel,
  isSnowbridgeDestination,
} from "../catalog/snowbridgeCatalog";
import type { Chain, Env, Token } from "../catalog/types";
import ComboBox, { type ComboOption } from "../components/ComboBox";
import { executeAcrossViaSwapApi } from "../features/transfer/executors/acrossSwapExecutor";
import { executeSnowbridgeToAssetHub } from "../features/transfer/executors/snowbridgeExecutor";
import { buildTransferPlan } from "../features/transfer/planner";
import type { TransferIntent, TransferPlan } from "../features/transfer/types";
import { waitForDepositFill } from "../services/acrossDepositStatus";

type Network = Env;

const isEvmAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());

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

function buildProgressLines(plan: TransferPlan): ProgressLine[] {
  const lines: ProgressLine[] = [];

  plan.steps.forEach((step, i) => {
    if (step.kind === "across") {
      lines.push({
        id: `across-${i}-approve`,
        label: `Across approval (${i + 1})`,
        status: "idle",
      });
      lines.push({
        id: `across-${i}-bridge`,
        label: `Across bridge tx (${i + 1})`,
        status: "idle",
      });

      if (step.recipientMode === "depositor") {
        lines.push({
          id: `across-${i}-wait-fill`,
          label: `Across fill on Sepolia (${i + 1})`,
          status: "idle",
        });
      }
      return;
    }

    lines.push({
      id: `snowbridge-${i}-prepare`,
      label: `Prepare WETH for Snowbridge (${i + 1})`,
      status: "idle",
    });

    lines.push({
      id: `snowbridge-${i}-approve`,
      label: `Approve WETH for Snowbridge (${i + 1})`,
      status: "idle",
    });

    lines.push({
      id: `snowbridge-${i}-bridge`,
      label: `${getSnowbridgeProgressLabel(step.originChainId)} (${i + 1})`,
      status: "idle",
    });
  });

  return lines;
}

function shortenMiddle(text: string, head = 10, tail = 8): string {
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
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

  const chainOptions: ComboOption<number>[] = useMemo(
    () => chains.map((c) => ({ value: c.chainId, label: c.name, subLabel: String(c.chainId) })),
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
      destinations.map((c) => ({ value: c.chainId, label: c.name, subLabel: String(c.chainId) })),
    [destinations]
  );

  const selectedToken = useMemo(() => tokens.find((t) => t.key === tokenKey) ?? null, [tokens, tokenKey]);
  const snowbridgeConfig = useMemo(() => getSnowbridgeConfig(network), [network]);

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
    m.set(snowbridgeConfig.destinationChain.chainId, snowbridgeConfig.destinationChain.name);
    return m;
  }, [chains, destinations, snowbridgeConfig]);

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

      try {
        const list = await getAcrossChains(network);
        if (cancelled) return;

        list.sort((a, b) => a.chainId - b.chainId);
        setChains(list);
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
  }, [network]);

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

      if (sourceChainId == null) return;

      setLoadingTokens(true);
      try {
        const list = await getAcrossTokensForChain(network, sourceChainId);
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

      if (sourceChainId == null) return;
      if (!tokenKey) return;

      setLoadingDestinations(true);
      try {
        const [acrossDestinations] = await Promise.all([
          getAcrossDestinations(network, sourceChainId, tokenKey),
        ]);

        if (cancelled) return;

        const snowbridgeDestinations = getSnowbridgeDestinations({
          env: network,
          originChainId: sourceChainId,
          tokenKey,
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
  }, [network, sourceChainId, tokenKey]);

  function updateProgressLine(id: string, patch: Partial<ProgressLine>) {
    setProgress((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    }));
  }

  function onSubmitPreview() {
    setError(null);
    setExec({});
    setProgress(emptyProgress());

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
      const built = buildTransferPlan(intent);
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
    setProgress({
      started: true,
      lines: buildProgressLines(plan),
      done: false,
    });

    let snowbridgeAmountRawFromAcross: string | undefined;
    let activeProgressLineId: string | null = null;

    try {
      const needsAcross = plan.steps.some((step) => step.kind === "across");
      const routes = needsAcross ? await getAcrossRoutesRaw(network) : [];

      for (let i = 0; i < plan.steps.length; i += 1) {
        const step = plan.steps[i];

        if (step.kind === "across") {
          const approvalLineId = `across-${i}-approve`;
          const bridgeLineId = `across-${i}-bridge`;

          activeProgressLineId = approvalLineId;
          updateProgressLine(approvalLineId, { status: "running", detail: undefined });
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
          });

          updateProgressLine(approvalLineId, {
            status: "success",
            hash: res.approvalTxHash ?? undefined,
          });

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
        activeProgressLineId = snowbridgePrepareLineId;

        const amountRaw =
          step.amountSource === "acrossMinOutput" ? snowbridgeAmountRawFromAcross : undefined;

        if (step.amountSource === "acrossMinOutput" && !amountRaw) {
          throw new Error("Missing Across output amount for Snowbridge step.");
        }

        const res = await executeSnowbridgeToAssetHub({
          env: network,
          recipientSubstrate: recipient.trim(),
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
      }

      setProgress((prev) => ({ ...prev, done: true }));
    } catch (e: any) {
      const msg = e?.message ?? "Execution failed";
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
                  {chainNameById.get(step.originChainId) ?? step.originChainId}
                  <span className="arrow">-&gt;</span>
                  {step.kind === "across"
                    ? (chainNameById.get(step.destinationChainId) ?? step.destinationChainId)
                    : (chainNameById.get(step.destinationParaId) ?? step.destinationParaId)}
                </div>

                <div className="muted">Wallet required: {step.requiredWallet}</div>
                {step.kind === "snowbridge" ? (
                  <div className="muted">ETH is wrapped to WETH on L1 before Snowbridge. Asset Hub receives WETH.</div>
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
