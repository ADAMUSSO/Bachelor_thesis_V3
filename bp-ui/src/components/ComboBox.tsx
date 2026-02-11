import { useEffect, useMemo, useRef, useState } from "react";

export type ComboOption<T extends string | number = string> = {
  value: T;
  label: string;
  subLabel?: string;
};

type Props<T extends string | number> = {
  label: string;
  placeholder?: string;
  value: T | null;
  onChange: (v: T | null) => void;
  options: ComboOption<T>[];
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
};

export default function ComboBox<T extends string | number>({
  label,
  placeholder = "Select…",
  value,
  onChange,
  options,
  disabled,
  loading,
  emptyText = "No results",
}: Props<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value]
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const shownText = open ? query : selected?.label ?? "";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const a = o.label.toLowerCase().includes(q);
      const b = (o.subLabel ?? "").toLowerCase().includes(q);
      return a || b;
    });
  }, [query, options]);

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    setQuery(selected?.label ?? "");
    queueMicrotask(() => inputRef.current?.select());
  }

  function commit(val: T) {
    onChange(val);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="cb" ref={rootRef}>
      <label className="cb__label">{label}</label>

      <div className={`cb__shell ${open ? "cb__shell--open" : ""} ${disabled ? "cb__shell--disabled" : ""}`}>
        <input
          ref={inputRef}
          className="cb__input"
          placeholder={loading ? "Loading…" : placeholder}
          value={shownText}
          onFocus={openMenu}
          onClick={openMenu}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
          }}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
        />

        <button
          type="button"
          className="cb__chev"
          onClick={() => (open ? setOpen(false) : openMenu())}
          disabled={disabled}
          aria-label="Toggle"
        >
          ▾
        </button>

        {open && (
          <div className="cb__menu" role="listbox">
            {loading ? (
              <div className="cb__empty">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="cb__empty">{emptyText}</div>
            ) : (
              filtered.slice(0, 50).map((o) => (
                <button
                  key={String(o.value)}
                  type="button"
                  className={`cb__item ${o.value === value ? "cb__item--active" : ""}`}
                  onClick={() => commit(o.value)}
                >
                  <div className="cb__itemMain">{o.label}</div>
                  {o.subLabel ? <div className="cb__itemSub">{o.subLabel}</div> : null}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
