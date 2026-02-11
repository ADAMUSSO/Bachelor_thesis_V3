import { useEffect, useMemo, useState } from "react";
import { getAcrossChains, getAcrossDestinations, getAcrossTokensForChain } from "../catalog/acrossCatalog";
import type { Env, Chain, Token } from "../catalog/types";
import ComboBox, { type ComboOption } from "../components/Combobox";



type Network = Env; // "mainnet" | "testnet"

export default function TransferPage() {
  const [network, setNetwork] = useState<Network>("testnet");

  const [chains, setChains] = useState<Chain[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [destinations, setDestinations] = useState<Chain[]>([]);

  const [sourceChainId, setSourceChainId] = useState<number | null>(null);
  const [destinationChainId, setDestinationChainId] = useState<number | null>(null);
  const [tokenKey, setTokenKey] = useState<string>("");
  const [amount, setAmount] = useState<string>("");

  const [loadingChains, setLoadingChains] = useState(false);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [error, setError] = useState<string | null>(null);



  //-------------- Options --------------
  const chainOptions: ComboOption<number>[] = useMemo(
  () => chains.map((c) => ({ value: c.chainId, label: c.name, subLabel: String(c.chainId) })),
  [chains]
);

const tokenOptions: ComboOption<string>[] = useMemo(
  () =>
    tokens.map((t) => ({
      value: t.key,
      label: t.symbol,
      subLabel: `${t.key.slice(0, 6)}…${t.key.slice(-4)}`,
    })),
  [tokens]
);

const destinationOptions: ComboOption<number>[] = useMemo(
  () =>
    destinations.map((c) => ({
      value: c.chainId,
      label: c.name,
      subLabel: String(c.chainId),
    })),
  [destinations]
);


  // ---------- Load chains when network changes ----------
  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);
      setLoadingChains(true);

      // reset selections on env change
      setChains([]);
      setTokens([]);
      setDestinations([]);
      setSourceChainId(null);
      setDestinationChainId(null);
      setTokenKey("");
      setAmount("");

      try {
        const list = await getAcrossChains(network);
        if (cancelled) return;

        // optional: sort by chainId for stable UI
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

  // ---------- Load tokens when source chain changes ----------
  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);
      setTokens([]);
      setDestinations([]);
      setDestinationChainId(null);
      setTokenKey("");

      if (sourceChainId == null) return;

      setLoadingTokens(true);
      try {
        const list = await getAcrossTokensForChain(network, sourceChainId);
        if (cancelled) return;

        // stable sort (symbol then address)
        list.sort((a, b) =>
          (a.symbol || "").localeCompare(b.symbol || "") || a.key.localeCompare(b.key)
        );

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

  const canSubmit = useMemo(() => {
    return (
      sourceChainId != null &&
      destinationChainId != null &&
      tokenKey.length > 0 &&
      amount.trim().length > 0
    );
  }, [sourceChainId, destinationChainId, tokenKey, amount]);

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

      {error ? <div className="muted" style={{ marginBottom: 10 }}>{error}</div> : null}

      <form className="form" onSubmit={(e) => e.preventDefault()}>
        {/* Source chain */}
       <ComboBox
          label="Source chain"
          placeholder="Type or pick source chain…"
          value={sourceChainId}
          onChange={(v) => setSourceChainId(v)}
          options={chainOptions}
          loading={loadingChains}
          disabled={loadingChains}
        />


        {/* Destination chain */}
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
          disabled={sourceChainId == null || !tokenKey || loadingDestinations}
        />


        {/* Token + Amount */}
        <div className="row2">
          <ComboBox
              label="Token"
              placeholder={
                sourceChainId == null
                  ? "Select source chain first"
                  : "Type or pick token…"
              }
              value={tokenKey || null}
              onChange={(v) => setTokenKey(v ?? "")}
              options={tokenOptions}
              loading={loadingTokens}
              disabled={sourceChainId == null || loadingTokens}
            />


          <div>
            <label className="label">Amount</label>
            <input
              className="control"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>

        <button type="button" className="submitBtn" disabled={!canSubmit}>
          Submit Transfer
        </button>

        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {loadingChains || loadingTokens || loadingDestinations
            ? "Fetching Across catalog…"
            : canSubmit
            ? `Ready: ${sourceChainId} → ${destinationChainId}`
            : "Pick source, token, destination, amount."}
        </div>
      </form>
    </section>
  );
}
