import { useEffect, useMemo, useState } from "react";
import { isAddress } from "viem";
import { isAddress as isSubstrateAddress } from "@polkadot/util-crypto";
import { getAcrossChains } from "../catalog/acrossCatalog";
import { POLKADOT_ASSETHUB_CHAIN, PASEO_ASSETHUB_CHAIN } from "../catalog/snowbridgeCatalog";
import type { Chain, Env } from "../catalog/types";
import ComboBox, { type ComboOption } from "../components/ComboBox";
import { getRpcUrl } from "../evm/rpcs";
import { fetchNonZeroBalances, type AssetBalance } from "../services/balanceLookup";

type Network = Env;

function shortenMiddle(text: string, head = 8, tail = 6): string {
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

export default function BalancePage() {
  const [network, setNetwork] = useState<Network>("testnet");
  const [chains, setChains] = useState<Chain[]>([]);
  const [chainKey, setChainKey] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [balances, setBalances] = useState<AssetBalance[]>([]);
  const [loadingChains, setLoadingChains] = useState(false);
  const [checkingBalances, setCheckingBalances] = useState(false);
  const [checkedWallet, setCheckedWallet] = useState<string | null>(null);
  const [checkedChainName, setCheckedChainName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedWalletAddress = walletAddress.trim();

  const selectedChain = useMemo(
    () => chains.find((chain) => chain.id === chainKey) ?? null,
    [chains, chainKey]
  );

  const walletIsValid = useMemo(() => {
    if (!trimmedWalletAddress || !selectedChain) return false;

    if (selectedChain.type === "substrate") {
      try {
        return isSubstrateAddress(trimmedWalletAddress);
      } catch {
        return false;
      }
    }

    return isAddress(trimmedWalletAddress);
  }, [trimmedWalletAddress, selectedChain]);

  const chainOptions: ComboOption<string>[] = useMemo(
    () =>
      chains.map((chain) => ({
        value: chain.id,
        label: chain.name,
        subLabel: chain.type === "substrate" ? `Parachain ${chain.chainId}` : String(chain.chainId),
      })),
    [chains]
  );

  const walletLabel = selectedChain?.type === "substrate" ? "Wallet address (SS58)" : "Wallet address";
  const walletPlaceholder = selectedChain?.type === "substrate" ? "5..." : "0x...";

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingChains(true);
      setError(null);
      setChains([]);
      setChainKey(null);
      setBalances([]);
      setCheckedWallet(null);
      setCheckedChainName(null);

      try {
        const availableChains = await getAcrossChains(network);
        if (cancelled) return;

        const rpcReadyChains = availableChains
          .filter((chain) => {
            try {
              getRpcUrl(chain.chainId);
              return true;
            } catch {
              return false;
            }
          })
          .sort((a, b) => a.chainId - b.chainId);

        const assetHubChain = network === "mainnet" ? POLKADOT_ASSETHUB_CHAIN : PASEO_ASSETHUB_CHAIN;
        const nextChains = [...rpcReadyChains, assetHubChain];

        setChains(nextChains);

        if (nextChains.length === 0) {
          setError(`No ${network} chains are available for balance lookups.`);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "Failed to load chains");
        }
      } finally {
        if (!cancelled) {
          setLoadingChains(false);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [network]);

  function resetResults() {
    setBalances([]);
    setCheckedWallet(null);
    setCheckedChainName(null);
    setError(null);
  }

  async function onCheckBalances() {
    if (!selectedChain || !walletIsValid) return;

    setCheckingBalances(true);
    setBalances([]);
    setCheckedWallet(null);
    setCheckedChainName(null);
    setError(null);

    try {
      const nextBalances = await fetchNonZeroBalances({
        env: network,
        chain: selectedChain,
        walletAddress: trimmedWalletAddress,
      });

      setBalances(nextBalances);
      setCheckedWallet(trimmedWalletAddress);
      setCheckedChainName(selectedChain.name);
    } catch (e: any) {
      setError(e?.message ?? "Failed to read balances");
    } finally {
      setCheckingBalances(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div className="panel__title">Balance</div>

        <div className="networkSwitch">
          <button
            type="button"
            className={`networkBtn ${network === "mainnet" ? "active" : ""}`}
            onClick={() => {
              setNetwork("mainnet");
              resetResults();
            }}
          >
            Mainnet
          </button>

          <button
            type="button"
            className={`networkBtn ${network === "testnet" ? "active" : ""}`}
            onClick={() => {
              setNetwork("testnet");
              resetResults();
            }}
          >
            Testnet
          </button>
        </div>
      </div>

      <div className="panel__hint" style={{ marginBottom: 14 }}>
        Reads non-zero balances from the supported token catalog on EVM chains and the Snowbridge registry on Asset Hub.
      </div>

      {error ? (
        <div className="muted" style={{ marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCheckBalances();
        }}
      >
        <ComboBox
          label="Chain"
          placeholder="Type or pick chain..."
          value={chainKey}
          onChange={(value) => {
            setChainKey(value);
            resetResults();
          }}
          options={chainOptions}
          loading={loadingChains}
          disabled={loadingChains || checkingBalances}
        />

        <div>
          <label className="label">{walletLabel}</label>
          <input
            className="control"
            placeholder={walletPlaceholder}
            value={walletAddress}
            onChange={(event) => {
              setWalletAddress(event.target.value);
              resetResults();
            }}
            disabled={checkingBalances}
          />
        </div>

        <button
          type="submit"
          className="submitBtn"
          disabled={selectedChain == null || !walletIsValid || checkingBalances}
        >
          {checkingBalances ? "Checking..." : "Check balances"}
        </button>

        <div className="muted" style={{ marginTop: -4, fontSize: 12 }}>
          {checkingBalances
            ? selectedChain?.type === "substrate"
              ? "Querying native and registered Asset Hub balances..."
              : "Querying native and ERC-20 balances..."
            : selectedChain == null
              ? "Select a chain first."
              : !trimmedWalletAddress
                ? "Enter a wallet address."
                : walletIsValid
                  ? "Ready to query."
                  : selectedChain.type === "substrate"
                    ? "Enter a valid Substrate SS58 address."
                    : "Enter a valid EVM wallet address."}
        </div>
      </form>

      {checkedWallet ? (
        <div className="previewCard">
          <div className="previewTitle">Lookup Result</div>

          <div className="previewRow">
            <strong>Wallet:</strong> {shortenMiddle(checkedWallet, 12, 8)}
          </div>

          <div className="previewRow">
            <strong>Chain:</strong> {checkedChainName}
          </div>

          <div className="previewRow">
            <strong>Non-zero balances:</strong> {balances.length}
          </div>

          {balances.length === 0 ? (
            <div className="muted" style={{ marginTop: 10 }}>
              No non-zero balances were found in the current supported lookup set for this chain.
            </div>
          ) : (
            <div className="balanceResults">
              {balances.map((balance) => (
                <div key={balance.key} className="balanceItem">
                  <div className="balanceItem__top">
                    <div className="balanceItem__symbol">{balance.symbol}</div>
                    <div className="balanceItem__value">{balance.displayAmount}</div>
                  </div>

                  <div className="balanceItem__meta">
                    {balance.isNative ? "Native asset" : shortenMiddle(balance.address ?? "", 10, 6)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
