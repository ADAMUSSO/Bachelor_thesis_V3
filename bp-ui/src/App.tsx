import { useEffect, useState } from "react";
import Header from "./components/Header";
import TransferPage from "./pages/TransferPage";
import BalancePage from "./pages/BalancePage";
import "./App.css";

type Page = "transfer" | "balance";

export default function App() {
  const [page, setPage] = useState<Page>("transfer");
  const [mountedPages, setMountedPages] = useState<Record<Page, boolean>>({
    transfer: true,
    balance: false,
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
        </div>
      </div>
    </div>
  );
}
