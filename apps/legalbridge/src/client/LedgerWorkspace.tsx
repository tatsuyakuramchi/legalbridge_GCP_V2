import { useEffect, useState } from "react";
type LedgerType = "vendors" | "works" | "conditions";
type Item = { id: string; type: LedgerType; code: string; title: string; subtitle: string; status?: string; updatedAt?: string; detail: Record<string, unknown> };
const labels: Record<LedgerType, string> = { vendors: "取引先", works: "作品・原作", conditions: "金銭条件" };

export function LedgerWorkspace({ initialType, initialQuery, selectedId }: { initialType?: LedgerType; initialQuery?: string; selectedId?: string }) {
  const [type, setType] = useState<LedgerType>(initialType ?? "vendors");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (initialType) setType(initialType);
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialType, initialQuery]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setSelected(null);
      setError("");
      fetch(`/api/v2/ledgers/${type}?q=${encodeURIComponent(query)}&limit=200`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setItems(data.items ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("台帳を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [type, query, reload]);
  useEffect(() => {
    if (!selectedId) return;
    const item = items.find((candidate) => candidate.id === selectedId);
    if (item) setSelected(item);
  }, [items, selectedId]);
  return <section className="page ledger-page">
    <div className="page-title"><div><p>MASTER LEDGERS</p><h1>台帳</h1><small>既存マスターと契約条件を読み取り専用で横断確認します</small></div></div>
    <div className="ledger-tabs">{(Object.keys(labels) as LedgerType[]).map((key) =>
      <button className={type === key ? "active" : ""} key={key} onClick={() => { setType(key); setQuery(""); }}>{labels[key]}</button>)}</div>
    <div className="ledger-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)}
      placeholder={`${labels[type]}を名称・コード・文書番号で検索`} /><span>{loading ? "検索中…" : `${items.length}件`}</span></div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    <div className="ledger-layout">
      <div className="ledger-list">{items.map((item) => <button key={item.id}
        className={selected?.id === item.id ? "selected" : ""} onClick={() => setSelected(item)}>
        <span>{item.code}</span><strong>{item.title}</strong><small>{item.subtitle || "—"}</small>
      </button>)}{!loading && !items.length && <div className="empty-state">該当するデータがありません。</div>}</div>
      <LedgerDetail item={selected} />
    </div>
  </section>;
}
function LedgerDetail({ item }: { item: Item | null }) {
  if (!item) return <aside className="panel ledger-detail empty-detail">一覧から項目を選択してください。</aside>;
  const entries = Object.entries(item.detail).filter(([, value]) => value !== null && value !== "");
  return <aside className="panel ledger-detail"><span className="detail-kicker">LEDGER DETAIL</span>
    <h2>{item.title}</h2><p>{item.code}　{item.subtitle}</p>
    <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "boolean" ? (value ? "はい" : "いいえ") : String(value)}</dd></div>)}</dl>
    <small className="mask-note">口座情報は表示しません。電話番号・メールアドレスはマスキングされています。</small>
  </aside>;
}
