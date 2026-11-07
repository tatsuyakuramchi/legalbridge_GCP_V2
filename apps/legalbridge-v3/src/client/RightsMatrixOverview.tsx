import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useDebounced } from "./ListTools.js";

/**
 * 作品台帳 › 地域×言語の一覧（作品をまたぐ。server/works/rights-matrix-overview.ts）。
 *
 * 行＝作品、列＝許諾言語。地域を選ぶとその地域のマス、選ばなければ全地域を畳んだマス
 * （いちばん気にすべき状態の色。空きのある地域の数を添える）。
 * 作品名かマスを押すと、その作品の「地域×言語」の表（作品 1 点）を開く。
 */

type CellState = "conflict" | "outside" | "exclusive" | "non_exclusive" | "open" | "none";
type Category = "publishing" | "game" | "other";
type Show = "granted" | "issues" | "open" | "all";
interface Axis { key: string; label: string; other: boolean }
interface Cell {
  language: string; state: CellState; parties: string[]; partyIds: number[]; grantIds: number[];
  grantedRegions: number; openRegions: number;
}
interface Row {
  work: { id: number; title: string; workCode: string | null; category: Category; derived: number };
  acquiredKnown: boolean; grants: number; parties: string[];
  counts: { conflict: number; outside: number; open: number }; cells: Cell[];
}
interface Overview {
  today: string; includeEnded: boolean; region: string | null; regions: Axis[]; languages: Axis[];
  rows: Row[]; total: number; truncated: boolean;
  counts: { works: number; conflict: number; outside: number; open: number };
  parties: Array<{ id: number; name: string }>;
}

const STATE_LABEL: Record<CellState, string> = {
  conflict: "独占がぶつかっている", outside: "取った範囲の外で許諾", exclusive: "独占で許諾",
  non_exclusive: "非独占で許諾", open: "空き（取った範囲の内・未許諾）", none: "取っていない・許諾なし"
};
const LEGEND: CellState[] = ["exclusive", "non_exclusive", "open", "conflict", "outside", "none"];
const CATEGORY_LABEL: Record<Category, string> = { publishing: "出版", game: "ボードゲーム等", other: "その他" };
const CATEGORIES: Array<[Category | "", string]> = [["", "すべて"], ["publishing", "出版"], ["game", "ボードゲーム等"], ["other", "その他"]];
const SHOWS: Array<[Show, string]> = [["granted", "許諾のある作品"], ["issues", "ぶつかり・範囲外のある作品"], ["open", "空きのある作品"], ["all", "すべての作品"]];
const short = (s: string, n = 7) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function RightsMatrixOverview({ onOpenWork, onClose }: {
  /** 作品 1 点の「地域×言語」の表を開く。 */
  onOpenWork: (workId: number) => void;
  onClose?: () => void;
}) {
  const [q, setQ] = useState("");
  const query = useDebounced(q, 300);
  const [category, setCategory] = useState<Category | "">("");
  const [region, setRegion] = useState("");
  const [party, setParty] = useState<number | "">("");
  const [show, setShow] = useState<Show>("granted");
  const [ended, setEnded] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ show });
    if (query.trim()) qs.set("q", query.trim());
    if (category) qs.set("category", category);
    if (region) qs.set("region", region);
    if (party !== "") qs.set("party", String(party));
    if (ended) qs.set("ended", "1");
    setLoading(true); setError(null);
    api.get<Overview>(`/works-rights-matrix?${qs}`)
      .then((r) => { if (alive) setData(r); })
      .catch((e: ApiError) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query, category, region, party, show, ended]);

  const regionLabel = data?.regions.find((r) => r.key === data.region)?.label ?? null;

  return (
    <div className="panel">
      <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>地域×言語の一覧</h2>
        <span className="faint">作品をまたいで、どの言語をどこに許諾しているか。行＝作品、列＝言語。作品名かマスを押すと作品の表を開きます</span>
        {onClose && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>}
      </div>
      <div className="panel-bd stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input className="inline-input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="作品の題名・コード" aria-label="作品で絞る" style={{ minWidth: 200 }} />
          <label className="row" style={{ gap: 4 }}>
            <span className="faint">地域</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="地域を選ぶ">
              <option value="">すべての地域（畳む）</option>
              {(data?.regions ?? []).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <span className="faint">取引先</span>
            <select value={party} onChange={(e) => setParty(e.target.value ? Number(e.target.value) : "")} aria-label="取引先で絞る">
              <option value="">すべて</option>
              {(data?.parties ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={ended} onChange={(e) => setEnded(e.target.checked)} />
            <span>終わった許諾も出す</span>
          </label>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="chips" role="group" aria-label="カテゴリで絞る">
            {CATEGORIES.map(([c, label]) => (
              <button key={c || "all"} className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{label}</button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="出す作品">
            {SHOWS.map(([s, label]) => (
              <button key={s} className="chip" aria-pressed={show === s} onClick={() => setShow(s)}>{label}</button>
            ))}
          </div>
        </div>

        {error && <div className="alert">{error}</div>}
        {!data && !error && <div className="faint">読み込み中…</div>}
        {data && (
          <>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="tag">作品 {data.counts.works}</span>
              {data.counts.conflict > 0 && <span className="tag rm-tag-conflict">ぶつかり {data.counts.conflict} 作品</span>}
              {data.counts.outside > 0 && <span className="tag rm-tag-outside">範囲外 {data.counts.outside} 作品</span>}
              <span className="tag rm-tag-open">空きのある作品 {data.counts.open}</span>
              {regionLabel && <span className="faint">地域：{regionLabel} のマス</span>}
              {loading && <span className="faint">更新中…</span>}
            </div>
            <div className="rm-legend" aria-label="凡例">
              {LEGEND.map((s) => <span key={s} className="row" style={{ gap: 4 }}><span className={`rm-swatch rm-${s}`} aria-hidden="true" />{STATE_LABEL[s]}</span>)}
            </div>

            {data.rows.length === 0
              ? <div className="faint">当てはまる作品がありません。</div>
              : (
                <div className="rm-scroll rm-scroll-tall">
                  <table className="rm-table">
                    <thead>
                      <tr>
                        <th className="rm-corner">作品 ＼ 言語</th>
                        {data.languages.map((l) => <th key={l.key} className={l.other ? "rm-other" : undefined}>{l.label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.work.id}>
                          <th className="rm-work">
                            <button className="linky" onClick={() => onOpenWork(r.work.id)} title="この作品の地域×言語の表を開く">{r.work.title}</button>
                            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                              {r.work.workCode && <span className="faint code">{r.work.workCode}</span>}
                              <span className="tag ghost">{CATEGORY_LABEL[r.work.category]}</span>
                              {r.work.derived > 0 && <span className="tag ghost accent" title="派生作品（言語版など）の許諾も、この行にまとめています">派生 {r.work.derived}</span>}
                              {r.counts.conflict > 0 && <span className="tag rm-tag-conflict">ぶつかり</span>}
                              {r.counts.outside > 0 && <span className="tag rm-tag-outside">範囲外</span>}
                              {!r.acquiredKnown && <span className="tag ghost warn" title="作者の条件（in）が無いので、取った範囲が分かりません">取った範囲不明</span>}
                            </div>
                          </th>
                          {r.cells.map((c) => {
                            const dim = party !== "" && !c.partyIds.includes(party);
                            const lang = data.languages.find((l) => l.key === c.language)?.label ?? c.language;
                            const extraOpen = !data.region && c.openRegions > 0 && c.state !== "open";
                            return (
                              <td key={c.language} className={`rm-${c.state}${dim ? " rm-dim" : ""}`}>
                                <button className="rm-cell" onClick={() => onOpenWork(r.work.id)}
                                        title={`${r.work.title} × ${lang}：${STATE_LABEL[c.state]}`
                                          + (c.parties.length ? `（${c.parties.join("・")}）` : "")
                                          + (!data.region && c.grantedRegions ? `／許諾 ${c.grantedRegions} 地域` : "")
                                          + (!data.region && c.openRegions ? `／空き ${c.openRegions} 地域` : "")}>
                                  {c.parties.length === 0
                                    ? <span className="faint">{c.state === "open" ? "空き" : "—"}</span>
                                    : <>
                                        {c.parties.slice(0, 2).map((n) => <span key={n} className="rm-name">{short(n)}</span>)}
                                        {c.parties.length > 2 && <span className="faint">ほか {c.parties.length - 2}</span>}
                                      </>}
                                  {extraOpen && <span className="rm-open-mark">空き {c.openRegions} 地域</span>}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            {data.truncated && <div className="note warn">作品が多いので先頭 {data.rows.length} 件だけ出しています（全 {data.total} 件）。題名・カテゴリ・取引先で絞ってください。</div>}
            <small className="faint">
              地域を選ばないときは、その言語の全地域を畳んで、いちばん気にすべき状態（ぶつかり → 範囲外 → 独占 → 非独占 → 空き）の色で出します。
              派生作品（言語版など）の許諾は元の作品の行にまとめています。作者から取った範囲は元の作品の作者の条件で見ます。
            </small>
          </>
        )}
      </div>
    </div>
  );
}
