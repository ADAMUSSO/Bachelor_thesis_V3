import "./Header.css";

type Page = "transfer" | "balance" | "docs";

type HeaderProps = {
  current: Page;
  onNavigate: (page: Page) => void;
};

export default function Header({ current, onNavigate }: HeaderProps) {
  const linkClass = (p: Page) =>
    `msNav__link ${current === p ? "msNav__link--active" : ""}`;

  return (
    <header className="msHeader">
      <div className="msHeader__inner">
        <div className="msBrand">
          <div className="msBrand__mark" />
          <div className="msBrand__name">Multiswap</div>
        </div>

        <nav className="msNav">
          <button className={linkClass("transfer")} onClick={() => onNavigate("transfer")}>
            Transfer
          </button>
          <button className={linkClass("balance")} onClick={() => onNavigate("balance")}>
            Balance
          </button>
          <button className={linkClass("docs")} onClick={() => onNavigate("docs")}>
            Docs
          </button>
        </nav>
      </div>
    </header>
  );
}
