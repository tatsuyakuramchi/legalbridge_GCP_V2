import { useEffect, useMemo, useRef, useState } from "react";

export type SearchableLedgerType = "vendors" | "works";

export type SearchableLedgerItem = {
  id: string;
  code: string;
  title: string;
  subtitle: string;
};

export function SearchableLedgerSelect({
  type,
  value,
  label,
  placeholder,
  helper,
  filter,
  onChange
}: {
  type: SearchableLedgerType;
  value: string;
  label: string;
  placeholder: string;
  helper?: string;
  filter?: (item: SearchableLedgerItem) => boolean;
  onChange: (value: string, item: SearchableLedgerItem | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchableLedgerItem[]>([]);
  const [selected, setSelected] = useState<SearchableLedgerItem | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailed(false);
      const params = new URLSearchParams({
        q: query.trim(),
        limit: "60"
      });
      fetch(`/api/v2/ledgers/${type}?${params.toString()}`, {
        signal: controller.signal
      })
        .then((response) =>
          response.ok ? response.json() : Promise.reject(new Error("search failed"))
        )
        .then((result) => setItems(result.items ?? []))
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setFailed(true);
          setItems([]);
        })
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, type]);

  const visible = useMemo(
    () => (filter ? items.filter(filter) : items),
    [filter, items]
  );

  function choose(item: SearchableLedgerItem) {
    const normalized = type === "works"
      ? canonicalWorkId(item.id)
      : item.id;
    if (!normalized) return;
    setSelected(item);
    setQuery(item.title);
    setOpen(false);
    onChange(normalized, item);
  }

  function clear() {
    setSelected(null);
    setQuery("");
    setOpen(false);
    onChange("", null);
  }

  return <label className="ledger-combobox-label">
    <span>{label}</span>
    {helper && <small>{helper}</small>}
    <div className="ledger-combobox" ref={root}>
      {value && selected ? (
        <div className="ledger-selection">
          <div>
            <strong>{selected.title}</strong>
            <small>{[selected.code, selected.subtitle].filter(Boolean).join("・")}</small>
          </div>
          <button type="button" onClick={clear}>変更</button>
        </div>
      ) : (
        <>
          <input
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            value={query}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
          />
          {open && <div className="ledger-combobox-results" role="listbox">
            {loading && <p>検索中…</p>}
            {!loading && failed && <p className="search-error">候補を取得できませんでした</p>}
            {!loading && !failed && !visible.length && <p>一致する候補がありません</p>}
            {!loading && visible.map((item) => (
              <button type="button" role="option" key={item.id}
                onClick={() => choose(item)}>
                <strong>{item.title}</strong>
                <span>{item.code}</span>
                <small>{item.subtitle}</small>
              </button>
            ))}
          </div>}
        </>
      )}
    </div>
  </label>;
}

export function isCanonicalWork(item: SearchableLedgerItem) {
  return item.id.startsWith("work:");
}

export function canonicalWorkId(value: string) {
  const match = /^work:(\d+)$/.exec(value);
  return match?.[1] ?? (/^\d+$/.test(value) ? value : "");
}
