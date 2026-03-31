import { useEffect, useState } from "react";
import Header from "./components/Header";
import TransferPage from "./pages/TransferPage";
import BalancePage from "./pages/BalancePage";
import DocsPage from "./pages/DocsPage";
import SwapPage from "./pages/SwapPage";
import "./App.css";

type Page = "transfer" | "balance" | "docs" | "swap";

export default function App() {
  const [page, setPage] = useState<Page>("transfer");
  const [mountedPages, setMountedPages] = useState<Record<Page, boolean>>({
    transfer: true,
    balance: false,
    docs: false,
    swap: false,
  });

  useEffect(() => {
    setMountedPages((prev) => (prev[page] ? prev : { ...prev, [page]: true }));
  }, [page]);

  return (
    <div className="msApp">
      <Header current={page} onNavigate={setPage} />

      <div className="msMain">
        <div className="centerStage">
          {mountedPages.transfer ? (
            <div className={`pageStage ${page === "transfer" ? "pageStage--active" : "pageStage--hidden"}`}>
              <TransferPage />
            </div>
          ) : null}

          {mountedPages.balance ? (
            <div className={`pageStage ${page === "balance" ? "pageStage--active" : "pageStage--hidden"}`}>
              <BalancePage />
            </div>
          ) : null}

          {mountedPages.docs ? (
            <div className={`pageStage ${page === "docs" ? "pageStage--active" : "pageStage--hidden"}`}>
              <DocsPage />
            </div>
          ) : null}

          {mountedPages.swap ? (
            <div className={`pageStage ${page === "swap" ? "pageStage--active" : "pageStage--hidden"}`}>
              <SwapPage />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
