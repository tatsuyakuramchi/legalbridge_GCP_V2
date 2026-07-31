import { useEffect, useState } from "react";
type Target = "matter" | "document" | "vendor" | "work";
type Result = { id: string; target: Target; title: string; code: string; description: string };
const labels: Record<Target, string> = { matter: "案件", document: "文書", vendor: "取引先", work: "作品・原作" };
export function GlobalSearch({ onNavigate }: { onNavigate: (target: Target) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/v2/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => { setResults(data.results ?? []); setOpen(true); })
        .catch(() => undefined);
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);
  return <div className="global-search">
    <input aria-label="グローバル検索" value={query} onChange={(event) => setQuery(event.target.value)}
      onFocus={() => setOpen(true)} placeholder="案件、文書、取引先、作品を検索" />
    {open && query.trim().length >= 2 && <div className="global-results">
      {results.map((result) => <button key={`${result.target}:${result.id}`} onClick={() => {
        onNavigate(result.target); setOpen(false);
      }}><span>{labels[result.target]}</span><strong>{result.title}</strong><small>{result.code}　{result.description}</small></button>)}
      {!results.length && <p>該当するデータがありません。</p>}
      <button className="search-close" onClick={() => setOpen(false)}>閉じる</button>
    </div>}
  </div>;
}
