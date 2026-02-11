import { useState } from "react";
import Header from "./components/Header";
import TransferPage from "./pages/TransferPage";
import BalancePage from "./pages/BalancePage";
import DocsPage from "./pages/DocsPage";
import "./App.css";

type Page = "transfer" | "balance" | "docs";

export default function App() {
  const [page, setPage] = useState<Page>("transfer");

  return (
    <div className="msApp">
      <Header current={page} onNavigate={setPage} />

      <div className="msMain">
        <div className="centerStage">
          {page === "transfer" && <TransferPage />}
          {page === "balance" && <BalancePage />}
          {page === "docs" && <DocsPage />}
        </div>
      </div>
    </div>
  );
}
