import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";

export type SearchTarget =
  | "matter" | "condition" | "document" | "party" | "work" | "payment" | "agreement" | "request";
export interface SearchHit {
  target: SearchTarget; id: number; code: string | null; title: string; context: string;
}

const LABEL: Record<SearchTarget, string> = {
  matter: "案件", agreement: "契約", condition: "条件", document: "文書", request: "依頼",
  party: "取引先", work: "作品", payment: "支払"
};
const ORDER: SearchTarget[] = ["matter", "agreement", "condition", "document", "request", "party", "work", "payment"];
const RECENT_KEY = "lb.search.recent";

/** 最近開いたもの。この端末のこの人だけの便利機能（消えても困らない）。 */
function loadRecent(): SearchHit[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as SearchHit[]; } catch { return []; }
}
function saveRecent(hit: SearchHit) {
  try {
    const next = [hit, ...loadRecent().filter((h) => !(h.target === hit.target && h.id === hit.id))].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* 保存できなくても検索はできる */ }
}

/** 当たった言葉に印を付ける。揃えた形（全角→半角）で比べる。 */
function Marked({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length || !text) return <>{text}</>;
  const norm = text.normalize("NFKC").toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const t of tokens) {
    const needle = t.toLowerCase();
    let at = norm.indexOf(needle);
    while (needle && at >= 0) { marks.push([at, at + needle.length]); at = norm.indexOf(needle, at + needle.length); }
  }
  // NFKC で長さが変わった文字列は印を諦める（位置がずれる）。
  if (!marks.length || norm.length !== text.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([s, e], i) => {
    if (s < pos) return;
    out.push(text.slice(pos, s), <mark key={i}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  out.push(text.slice(pos));
  return <>{out}</>;
}

/**
 * 横断検索。ナビに常設して、どの画面からでも番号や名前で辿れるようにする。
 *
 * - `/` か Ctrl（⌘）+K で検索欄へ。↑↓で選び、Enter で開く。Esc で閉じる。
 * - 空白で区切ると「すべてを含む」。全角・半角、ハイフンの書き方、ひらがな・カタカナは揃えて比べる。
 * - 種類ごとに6件。まだあれば「もっと見る」でその種類だけ多めに引く。
 * - 何も打っていないときは、最近開いたものを出す。
 * 入力のたびには引かず、打ち終わってから引く。
 */
export function GlobalSearch({ onOpen }: { onOpen: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [more, setMore] = useState<Partial<Record<SearchTarget, boolean>>>({});
  const [expanded, setExpanded] = useState<SearchTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<SearchHit[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 左の桁は縦に送るので（overflow）、中に置いた結果は桁の幅で切れる。
  // 画面に固定して、検索欄の下に出す。
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = input.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const tokens = useMemo(() => query.normalize("NFKC").trim().split(/\s+/).filter(Boolean), [query]);

  // どの画面からでも / と Ctrl+K で検索欄へ（入力中の欄では / を奪わない）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)
        || (e.target instanceof HTMLElement && e.target.isContentEditable);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault(); input.current?.focus(); input.current?.select(); setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 外を押したら閉じる。
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    setExpanded(null);
    if (q.normalize("NFKC").length < 2) { setHits(null); setMore({}); return; }
    setBusy(true);
    timer.current = setTimeout(() => {
      api.get<{ results: SearchHit[]; more?: Partial<Record<SearchTarget, boolean>> }>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => { setHits(r.results); setMore(r.more ?? {}); setActive(0); })
        .catch(() => { setHits([]); setMore({}); })
        .finally(() => setBusy(false));
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  async function showMore(target: SearchTarget) {
    setBusy(true);
    try {
      const r = await api.get<{ results: SearchHit[]; more?: Partial<Record<SearchTarget, boolean>> }>(
        `/search?q=${encodeURIComponent(query.trim())}&type=${target}`);
      setHits((cur) => [...(cur ?? []).filter((h) => h.target !== target), ...r.results]);
      setMore((m) => ({ ...m, [target]: Boolean(r.more?.[target]) }));
      setExpanded(target);
    } finally { setBusy(false); }
  }

  // 並びは種類の順。キーボードで動かす順と画面の順を揃える。
  const showing = hits ?? (query.trim() ? [] : recent);
  const ordered = ORDER.flatMap((t) => showing.filter((h) => h.target === t));
  const grouped = ORDER.map((t) => [t, ordered.filter((h) => h.target === t)] as const).filter(([, l]) => l.length);

  function choose(hit: SearchHit) {
    saveRecent(hit);
    onOpen(hit);
    setQuery(""); setHits(null); setOpen(false);
    input.current?.blur();
  }

  const panelOpen = open && (hits !== null || (!query.trim() && recent.length > 0));
  let index = -1;

  return (
    <div className="search" ref={box}>
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="番号・名前・相手先で探す（/）"
        aria-label="横断検索"
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls="global-search-results"
        aria-activedescendant={panelOpen && ordered[active] ? `gs-${ordered[active].target}-${ordered[active].id}` : undefined}
        onFocus={() => { setRecent(loadRecent()); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setQuery(""); setHits(null); setOpen(false); input.current?.blur(); return; }
          if (!ordered.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, ordered.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); const h = ordered[active] ?? ordered[0]; if (h) choose(h); }
        }}
      />
      {panelOpen && (
        <div className="search-results" id="global-search-results" role="listbox"
             style={pos ? { top: pos.top, left: pos.left } : undefined}>
          {!hits && <div className="search-group-hd">最近開いたもの</div>}
          {hits && busy && <div className="faint">探しています…</div>}
          {hits && !busy && !hits.length && (
            <div className="faint" style={{ padding: 6 }}>
              見つかりません。言葉を減らすか、番号の一部（例：2026-0012）で探してください。
            </div>
          )}
          {grouped.map(([target, list]) => (
            <div key={target} className="search-group">
              <div className="search-group-hd">
                {LABEL[target]} {list.length}{more[target] ? "+" : ""}
              </div>
              {list.map((h) => {
                index += 1;
                const i = index;
                return (
                  <button key={`${h.target}-${h.id}`} id={`gs-${h.target}-${h.id}`} role="option"
                    aria-selected={i === active} className="search-hit"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(h)}>
                    <span className="code">{h.code ? <Marked text={h.code} tokens={tokens} /> : `#${h.id}`}</span>
                    <span className="search-title"><Marked text={h.title} tokens={tokens} /></span>
                    {h.context && <span className="faint search-context"><Marked text={h.context} tokens={tokens} /></span>}
                  </button>
                );
              })}
              {hits && more[target] && expanded !== target && (
                <button className="linky search-more" disabled={busy} onClick={() => void showMore(target)}>
                  {LABEL[target]}をもっと見る
                </button>
              )}
              {hits && more[target] && expanded === target && (
                <div className="faint search-more">まだあります。言葉を足して絞ってください。</div>
              )}
            </div>
          ))}
          <div className="search-help faint">↑↓ で選ぶ · Enter で開く · Esc で閉じる · 空白で区切ると「すべてを含む」</div>
        </div>
      )}
    </div>
  );
}
