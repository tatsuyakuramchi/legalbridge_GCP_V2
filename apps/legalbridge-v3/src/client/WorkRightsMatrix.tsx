import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { RightsMatrixReport } from "./RightsMatrixReport.js";

/**
 * 作品 › 許諾地域 × 許諾言語（server/works/rights-matrix.ts）。
 *
 * 行＝地域、列＝言語、マス＝そこを覆う許諾（OUT 条件）。作者から取った範囲（作品の権利包絡）と
 * 照らして、独占のぶつかり・取った範囲の外・空きを色で出す。マスを押すと、覆っている許諾が下に出る。
 */

interface ScopeValue { code: string | null; label: string }
interface Grant {
  id: number; conditionNo: string | null; name: string; partyId: number; partyName: string;
  workId: number; workTitle: string; usageLabel: string; exclusivity: "exclusive" | "non_exclusive" | null;
  termStart: string | null; termEnd: string | null; status: string;
  regions: ScopeValue[]; languages: ScopeValue[]; ended: boolean; scheduled: boolean;
}
type CellState = "conflict" | "outside" | "exclusive" | "non_exclusive" | "open" | "none";
interface Axis { key: string; label: string; other: boolean }
interface Cell { region: string; language: string; state: CellState; grantIds: number[]; conflicts: Array<[number, number]> }
interface Matrix {
  work: { id: number; title: string }; today: string; includeEnded: boolean;
  acquired: { known: boolean; regions: ScopeValue[]; languages: ScopeValue[] };
  regions: Axis[]; languages: Axis[]; grants: Grant[]; cells: Cell[];
  counts: { conflict: number; outside: number; granted: number; open: number };
}

const STATE_LABEL: Record<CellState, string> = {
  conflict: "独占がぶつかっている", outside: "取った範囲の外で許諾", exclusive: "独占で許諾",
  non_exclusive: "非独占で許諾", open: "空き（取った範囲の内・未許諾）", none: "取っていない・許諾なし"
};
const LEGEND: CellState[] = ["exclusive", "non_exclusive", "open", "conflict", "outside", "none"];
const short = (s: string, n = 8) => (s.length > n ? `${s.slice(0, n)}…` : s);
const scopeText = (xs: ScopeValue[], all: string) => (xs.length ? xs.map((x) => x.label).join("・") : all);
const termText = (g: Pick<Grant, "termStart" | "termEnd">) =>
  !g.termStart && !g.termEnd ? "期間の定めなし" : `${g.termStart ?? "—"} 〜 ${g.termEnd ?? "定めなし"}`;
const exclText = (e: Grant["exclusivity"]) => (e === "exclusive" ? "独占" : e === "non_exclusive" ? "非独占" : "独占の定めなし");

export function WorkRightsMatrix({ workId, onOpenCondition, onOpenWork }: {
  workId: number;
  onOpenCondition?: (id: number) => void;
  onOpenWork?: (id: number) => void;
}) {
  const [data, setData] = useState<Matrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [party, setParty] = useState<number | "">("");
  const [picked, setPicked] = useState<{ region: string; language: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.get<Matrix>(`/works/${workId}/rights-matrix${ended ? "?ended=1" : ""}`)
      .then((r) => { if (alive) setData(r); })
      .catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [workId, ended]);
  useEffect(() => { setPicked(null); setParty(""); }, [workId]);

  const byId = useMemo(() => new Map((data?.grants ?? []).map((g) => [g.id, g])), [data]);
  const cellOf = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const c of data?.cells ?? []) m.set(`${c.region}|${c.language}`, c);
    return m;
  }, [data]);
  const parties = useMemo(() => [...new Map((data?.grants ?? []).map((g) => [g.partyId, g.partyName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "ja")), [data]);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="panel"><div className="panel-bd faint">読み込み中…</div></div>;

  const cond = (g: Grant) => onOpenCondition
    ? <button className="linky code" onClick={() => onOpenCondition(g.id)}>{g.conditionNo ?? `#${g.id}`}</button>
    : <span className="code">{g.conditionNo ?? `#${g.id}`}</span>;
  const work = (g: Grant) => g.workId === data.work.id ? null
    : onOpenWork ? <button className="linky" onClick={() => onOpenWork(g.workId)}>{g.workTitle}</button> : <span>{g.workTitle}</span>;

  const pickedCell = picked ? cellOf.get(`${picked.region}|${picked.language}`) ?? null : null;
  const pickedGrants = (pickedCell?.grantIds ?? []).map((id) => byId.get(id)).filter((g): g is Grant => !!g);
  const regionLabel = (k: string) => data.regions.find((r) => r.key === k)?.label ?? k;
  const languageLabel = (k: string) => data.languages.find((l) => l.key === k)?.label ?? k;

  const reportQuery = new URLSearchParams();
  if (ended) reportQuery.set("ended", "1");
  if (party !== "") reportQuery.set("party", String(party));

  return (
    <div className="stack">
      {(data.counts.conflict > 0 || data.counts.outside > 0) && (
        <div className="note warn stack" style={{ gap: 2 }}>
          {data.counts.conflict > 0 && <span>・独占の許諾が、期間の重なるほかの許諾とぶつかっているマスが {data.counts.conflict} あります。</span>}
          {data.counts.outside > 0 && <span>・作者から取った範囲の外で許諾しているマスが {data.counts.outside} あります。</span>}
        </div>
      )}

      <div className="panel">
        <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>許諾地域 × 許諾言語</h2>
          <span className="faint">行＝地域、列＝言語。マスを押すと、そこを覆う許諾が下に出ます</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 4 }}>
              <span className="faint">取引先</span>
              <select value={party} onChange={(e) => setParty(e.target.value ? Number(e.target.value) : "")} aria-label="取引先で絞る">
                <option value="">すべて</option>
                {parties.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={ended} onChange={(e) => setEnded(e.target.checked)} />
              <span>終わった許諾も出す</span>
            </label>
          </span>
        </div>
        <div className="panel-bd stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <span className="faint">作者から取った範囲：</span>
            {data.acquired.known
              ? <span>地域 {scopeText(data.acquired.regions, "全世界")} ／ 言語 {scopeText(data.acquired.languages, "全言語")}</span>
              : <span className="tag warn">作者の条件（IN）が無いので分かりません。空き・範囲外は出していません</span>}
            <span style={{ marginLeft: "auto" }} />
            <span className="tag">許諾 {data.grants.length} 本</span>
            {data.acquired.known && <span className="tag ok">空き {data.counts.open}</span>}
          </div>

          <div className="rm-legend" aria-label="凡例">
            {LEGEND.map((s) => <span key={s} className="row" style={{ gap: 4 }}><span className={`rm-swatch rm-${s}`} aria-hidden="true" />{STATE_LABEL[s]}</span>)}
          </div>

          {data.grants.length === 0 && !data.acquired.known
            ? <div className="faint">この作品には、許諾（OUT の利用許諾の条件）も作者の条件もありません。</div>
            : (
              <div className="rm-scroll">
                <table className="rm-table">
                  <thead>
                    <tr>
                      <th className="rm-corner">地域 ＼ 言語</th>
                      {data.languages.map((l) => <th key={l.key} className={l.other ? "rm-other" : undefined}>{l.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.regions.map((r) => (
                      <tr key={r.key}>
                        <th className={r.other ? "rm-other" : undefined}>{r.label}</th>
                        {data.languages.map((l) => {
                          const c = cellOf.get(`${r.key}|${l.key}`);
                          if (!c) return <td key={l.key} />;
                          const gs = c.grantIds.map((id) => byId.get(id)).filter((g): g is Grant => !!g);
                          const dim = party !== "" && !gs.some((g) => g.partyId === party);
                          const names = [...new Set(gs.map((g) => g.partyName))];
                          const on = picked?.region === r.key && picked?.language === l.key;
                          return (
                            <td key={l.key} className={`rm-${c.state}${dim ? " rm-dim" : ""}`}>
                              <button className="rm-cell" aria-pressed={on}
                                      title={`${r.label} × ${l.label}：${STATE_LABEL[c.state]}${names.length ? `（${names.join("・")}）` : ""}`}
                                      onClick={() => setPicked(on ? null : { region: r.key, language: l.key })}>
                                {names.length === 0
                                  ? <span className="faint">{c.state === "open" ? "空き" : "—"}</span>
                                  : <>
                                      {names.slice(0, 2).map((n) => <span key={n} className="rm-name">{short(n)}</span>)}
                                      {names.length > 2 && <span className="faint">ほか {names.length - 2}</span>}
                                    </>}
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
          <small className="faint">
            地域・言語を挙げていない条件は、その次元が無制限（全世界・全言語）として全部のマスを覆います。
            「その他の地域」「その他の言語」は、表に出ていない国・言語のまとめで、全世界・全言語の許諾だけが覆います。
          </small>
        </div>
      </div>

      {/* いまの表（終わった許諾・取引先の絞り込みのまま）を A4 横のレポートに。要確認と許諾の一覧も付く。 */}
      <RightsMatrixReport path={`/works/${workId}/rights-matrix/report`} query={reportQuery}
                          hint={party !== "" ? "選んだ取引先の無いマスは薄く、許諾の一覧はその取引先だけになります" : undefined} />

      {pickedCell && (
        <div className="panel">
          <div className="panel-hd">
            <h2>{regionLabel(pickedCell.region)} × {languageLabel(pickedCell.language)}</h2>
            <span className={`tag rm-tag-${pickedCell.state}`}>{STATE_LABEL[pickedCell.state]}</span>
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPicked(null)}>閉じる</button>
          </div>
          <div className="panel-bd stack" style={{ gap: 6 }}>
            {pickedCell.conflicts.map(([a, b]) => {
              const ga = byId.get(a), gb = byId.get(b);
              return ga && gb ? (
                <div key={`${a}-${b}`} className="note warn">
                  {ga.partyName}（{exclText(ga.exclusivity)}・{termText(ga)}）と {gb.partyName}（{exclText(gb.exclusivity)}・{termText(gb)}）の期間が重なっています
                </div>
              ) : null;
            })}
            {pickedGrants.length === 0
              ? <span className="faint">{pickedCell.state === "open" ? "作者から取った範囲の内で、まだ誰にも許諾していません。" : "許諾はありません。"}</span>
              : <GrantTable grants={pickedGrants} cond={cond} work={work} />}
          </div>
        </div>
      )}

      {data.grants.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>許諾の一覧</h2><span className="faint">この作品と派生作品（言語版など）の OUT の利用許諾</span></div>
          <div className="panel-bd">
            <GrantTable grants={party === "" ? data.grants : data.grants.filter((g) => g.partyId === party)} cond={cond} work={work} />
          </div>
        </div>
      )}
    </div>
  );
}

function GrantTable({ grants, cond, work }: {
  grants: Grant[]; cond: (g: Grant) => ReactNode; work: (g: Grant) => ReactNode;
}) {
  return (
    <div className="rm-scroll">
      <table className="compact">
        <thead><tr><th>取引先</th><th>条件</th><th>利用形態</th><th>独占</th><th>期間</th><th>地域</th><th>言語</th></tr></thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id}>
              <td><b>{g.partyName}</b>{work(g) && <div className="faint">作品：{work(g)}</div>}</td>
              <td>{cond(g)}<div className="faint">{g.name}</div></td>
              <td>{g.usageLabel}</td>
              <td>{g.exclusivity === "exclusive" ? <span className="tag accent">独占</span> : exclText(g.exclusivity)}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {termText(g)}
                {g.ended && <span className="tag ghost" style={{ marginLeft: 4 }}>終了</span>}
                {g.scheduled && <span className="tag ghost accent" style={{ marginLeft: 4 }}>予定</span>}
              </td>
              <td>{scopeText(g.regions, "全世界")}</td>
              <td>{scopeText(g.languages, "全言語")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
