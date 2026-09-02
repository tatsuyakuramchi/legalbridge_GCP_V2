import { useEffect, useState } from "react";

// 当社の担当者マスタ（staff）からメールアドレスを検索して選ぶ小型の検索窓。
// 文書メール送信のCC・メール設定の既定CCなど「アドレスを楽に足したい」場所で使う。
// 選ぶと onPick(email, name) を呼ぶだけで、入力欄への追記は呼び出し側が行う。

type StaffHit = { id: string; name: string; email: string; department: string };

export function StaffEmailSearch({ label, onPick }: {
  label: string;
  onPick: (email: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StaffHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setHits([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/v2/master-data/search?type=staff&q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal });
        if (!response.ok) { setHits([]); return; }
        const data = await response.json();
        setHits((data.items ?? [])
          .map((item: { id?: unknown; label?: unknown; values?: Record<string, unknown> }) => ({
            id: String(item.id ?? ""),
            name: String(item.values?.staff_name ?? item.label ?? ""),
            email: String(item.values?.email ?? ""),
            department: String(item.values?.department ?? "")
          }))
          .filter((s: StaffHit) => s.email.includes("@"))
          .slice(0, 8));
      } catch { /* 中断・失敗は空のまま */ }
      finally { setLoading(false); }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  return <div className="staff-email-search">
    <label>{label}
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="氏名・部署・メールで検索…" /></label>
    {loading && <small>検索しています…</small>}
    {!loading && query.trim() !== "" && !hits.length &&
      <small>該当する担当者がいません（担当者マスタにメールが登録されている人だけ出ます）。</small>}
    {hits.length > 0 && <div className="staff-email-hits">
      {hits.map((hit) => <button type="button" key={hit.id}
        onClick={() => { onPick(hit.email, hit.name); setQuery(""); setHits([]); }}>
        <strong>{hit.name}</strong>
        <span>{hit.department}</span>
        <small>{hit.email}</small>
      </button>)}
    </div>}
  </div>;
}
