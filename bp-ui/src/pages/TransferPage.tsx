import { useEffect, useMemo, useState } from "react";
import {
  getAcrossChains,
  getAcrossDestinations,
  getAcrossTokensForChain,
  getAcrossRoutesRaw,
} from "../catalog/acrossCatalog";
import type { Env, Chain, Token } from "../catalog/types";
import ComboBox, { type ComboOption } from "../components/ComboBox";
import { buildTransferPlan } from "../features/transfer/planner";
import type { TransferPlan, TransferIntent } from "../features/transfer/types";
import { executeAcrossViaSwapApi } from "../features/transfer/executors/acrossSwapExecutor";

type Network = Env;

const isEvmAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());

type StepStatus = "idle" | "running" | "success" | "error";

type SubmitProgress = {
  started: boolean;
  approval: StepStatus; // approve tx (ak treba)
  swap: StepStatus; // bridge tx
  done: boolean;
  hashes: { approval?: string; swap?: string };
  error?: string;
};

function StepBadge({ status }: { status: StepStatus }) {
  if (status === "running") return <span className="badge badge--spin" aria-label="running" />;
  if (status === "success") return <span className="badge badge--ok">✓</span>;
  if (status === "error") return <span className="badge badge--err">×</span>;
  return <span className="badge badge--idle">•</span>;
}

const emptyProgress = (): SubmitProgress => ({
  started: false,
  approval: "idle",
  swap: "idle",
  done: false,
  hashes: {},
});

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

  const [progress, setProgress] = useState<SubmitProgress>(emptyProgress());

  // ---------- Options ----------
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
          ? `${t.address.slice(0, 6)}…${t.address.slice(-4)}`
          : "",
      })),
    [tokens]
  );

  const destinationOptions: ComboOption<number>[] = useMemo(
    () => destinations.map((c) => ({ value: c.chainId, label: c.name, subLabel: String(c.chainId) })),
    [destinations]
  );

  const selectedToken = useMemo(
    () => tokens.find((t) => t.key === tokenKey) ?? null,
    [tokens, tokenKey]
  );

  const canSubmit = useMemo(() => {
    return (
      sourceChainId != null &&
      tokenKey.length > 0 &&
      destinationChainId != null &&
      amount.trim().length > 0 &&
      isEvmAddress(recipient)
    );
  }, [sourceChainId, tokenKey, destinationChainId, amount, recipient]);

  // ---------- Load chains when network changes ----------
  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);
      setLoadingChains(true);

      // reset on env change
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

  // ---------- Load tokens when source changes ----------
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

  // ---------- Load destinations when token changes ----------
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
        const list = await getAcrossDestinations(network, sourceChainId, tokenKey);
        if (cancelled) return;

        list.sort((a, b) => a.chainId - b.chainId);
        setDestinations(list);
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

  function onSubmitPreview() {
    setError(null);
    setExec({});
    setProgress(emptyProgress());

    if (sourceChainId == null || destinationChainId == null || !tokenKey) return;

    if (!isEvmAddress(recipient)) {
      alert("Invalid EVM address");
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
      approval: "running",
      swap: "idle",
      done: false,
      hashes: {},
    });

    try {
      const routes = await getAcrossRoutesRaw(network);

      const res = await executeAcrossViaSwapApi({
        env: network,
        originChainId: sourceChainId!,
        destinationChainId: destinationChainId!,
        tokenKey,
        amountHuman: amount,
        recipient: recipient.trim() as `0x${string}`,
        routes,
        tokens,
      });

      // approval krok
      if (res.approvalTxSent) {
        setProgress((p) => ({
          ...p,
          approval: "success",
          hashes: { ...p.hashes, approval: res.approvalTxHash ?? undefined },
          swap: "running",
        }));
      } else {
        setProgress((p) => ({
          ...p,
          approval: "success",
          swap: "running",
        }));
      }

      // swap mined
      const ok = res.swapReceiptStatus === "success";
      setProgress((p) => ({
        ...p,
        swap: ok ? "success" : "error",
        hashes: { ...p.hashes, swap: res.swapTxHash },
        done: ok,
      }));

      setExec({ hash: res.swapTxHash, status: res.swapReceiptStatus });
    } catch (e: any) {
      const msg = e?.message ?? "Execution failed";

      setExec({ err: msg });
      setProgress((p) => ({
        ...p,
        approval: p.approval === "running" ? "error" : p.approval,
        swap: p.swap === "running" ? "error" : p.swap,
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
        <div className="muted" style={{ marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <ComboBox
          label="Source chain"
          placeholder="Type or pick source chain…"
          value={sourceChainId}
          onChange={(v) => setSourceChainId(v)}
          options={chainOptions}
          loading={loadingChains}
          disabled={loadingChains || execLoading}
        />

        <div className="row2">
          <ComboBox
            label="Token"
            placeholder={sourceChainId == null ? "Select source chain first" : "Type or pick token…"}
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
              : "Type or pick destination chain…"
          }
          value={destinationChainId}
          onChange={(v) => setDestinationChainId(v)}
          options={destinationOptions}
          loading={loadingDestinations}
          disabled={sourceChainId == null || !tokenKey || loadingDestinations || execLoading}
        />

        <div>
          <label className="label">Recipient</label>
          <input
            className="control"
            placeholder="0x..."
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
                  `${selectedToken.symbol} (${selectedToken.address?.slice(0, 6)}…${selectedToken.address?.slice(-4)})`
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
                <div className="previewStepTitle">Across</div>

                <div className="previewFlow">
                  {chains.find((c) => c.chainId === step.originChainId)?.name ?? step.originChainId}
                  <span className="arrow">→</span>
                  {chains.find((c) => c.chainId === step.destinationChainId)?.name ??
                    step.destinationChainId}
                </div>

                <div className="muted">Wallet required: {step.requiredWallet}</div>
              </div>
            ))}
          </div>
        )}

        {progress.started && (
          <div className="previewCard" style={{ marginTop: 14 }}>
            <div className="previewTitle">Submit progress</div>

            <div className="progressRow">
              <StepBadge status={progress.approval} />
              <div className="progressText">Approve (if needed)</div>
              {progress.hashes.approval ? <div className="muted">{progress.hashes.approval}</div> : null}
            </div>

            <div className="progressRow">
              <StepBadge status={progress.swap} />
              <div className="progressText">Bridge transaction</div>
              {progress.hashes.swap ? <div className="muted">{progress.hashes.swap}</div> : null}
            </div>

            {progress.done && <div className="muted" style={{ marginTop: 8 }}>✅ Completed</div>}
            {progress.error && <div className="muted" style={{ marginTop: 8 }}>{progress.error}</div>}

            {exec.err ? <div className="muted" style={{ marginTop: 8 }}>{exec.err}</div> : null}
            {exec.hash ? <div className="muted" style={{ marginTop: 8 }}>Tx: {exec.hash}</div> : null}
            {exec.status ? <div className="muted" style={{ marginTop: 8 }}>Status: {exec.status}</div> : null}
          </div>
        )}

        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {loadingChains || loadingTokens || loadingDestinations
            ? "Fetching Across catalog…"
            : canSubmit
            ? `Ready: ${sourceChainId} → ${destinationChainId}`
            : "Pick source, token, destination, amount, recipient."}
        </div>
      </form>
    </section>
  );
}
