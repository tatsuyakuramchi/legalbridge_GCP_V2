import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export type SearchTarget = "matter" | "condition" | "document" | "party" | "work" | "payment";
export interface SearchHit {
  target: SearchTarget; id: number; code: string | null; title: string; context: string;
}

const LABEL: Record<SearchTarget, string> = {
  matter: "案件", condition: "条件", document: "文書",
  party: "取引先", work: "作品", payment: "支払"
};

/**
 * 横断検索。ナビに常設して、どの画面からでも番号や名前で辿れるようにする。
 * 入力のたびには引かず、打ち終わってから引く（1文字ごとに6本のクエリを
 * 投げると、件数が増えたときに画面が固まる）。
 */
export function GlobalSearch({ onOpen }: { onOpen: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) { setHits(null); return; }
    setBusy(true);
    timer.current = setTimeout(() => {
      api.get<{ results: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => setHits(r.results))
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  const grouped = (hits ?? []).reduce<Record<string, SearchHit[]>>((acc, h) => {
    (acc[h.target] ??= []).push(h);
    return acc;
  }, {});

  return (
    <div className="search">
      <input
        type="search"
        value={query}
        placeholder="番号・名前・相手先で探す"
        aria-label="横断検索"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setHits(null); } }}
      />
      {hits !== null && (
        <div className="search-results">
          {busy && <div className="faint">探しています…</div>}
          {!busy && !hits.length && <div className="faint">見つかりません</div>}
          {Object.entries(grouped).map(([target, list]) => (
            <div key={target} className="search-group">
              <div className="search-group-hd">{LABEL[target as SearchTarget]} {list.length}</div>
              {list.map((h) => (
                <button key={`${h.target}-${h.id}`} className="search-hit"
                  onClick={() => { onOpen(h); setQuery(""); setHits(null); }}>
                  <span className="code">{h.code ?? `#${h.id}`}</span>
                  <span className="search-title">{h.title}</span>
                  {h.context && <span className="faint">{h.context}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
