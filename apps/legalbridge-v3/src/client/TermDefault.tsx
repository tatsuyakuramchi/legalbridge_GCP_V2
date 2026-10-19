import { useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 許諾期間の入っていない条件に「3 年・以後 3 年ごとに自動更新」を入れる（基本契約に合わせる）。
 *
 * 契約書の無い条件から一括で作った条件書は、条件に終了日が無く「期間の定めなし」で出ていた。
 * 1. 出版の条件書に載っている条件のうち、終了日が空のものに、開始日の 3 年後の前日と
 *    自動更新（3 年ごと）を入れる。開始が古い条件は「（更新 n回）」が付く。
 * 2. 決定済みの条件書は中身が凍っているので、訂正版で出し直す（元の締結日・決定日のまま）。
 */
interface Target {
  conditionId: number; conditionNo: string | null; conditionName: string;
  partyName: string | null; workTitle: string | null; documentNos: string[];
  termStart: string | null; newTermEnd: string | null; label: string | null; skip: string | null;
}
interface DocTarget {
  documentId: number; documentNo: string | null; partyName: string | null;
  issuedOn: string | null; conditions: number; skip: string | null;
  /** 前に決定に失敗して残った、この出し直しの下書き。作り直さずにこれを決定する。 */
  reuseDraftId: number | null;
}
interface DocResult {
  documentId: number; documentNo: string | null; status: "reissued" | "skipped" | "error";
  newDocumentNo?: string | null; message?: string;
}

export function TermDefault() {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [docs, setDocs] = useState<DocTarget[] | null>(null);
  const [pickedDocs, setPickedDocs] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<DocResult[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : String(e));

  async function tryIt() {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.get<{ targets: Target[] }>("/conditions/term-default");
      setTargets(r.targets);
      setPicked(new Set(r.targets.filter((t) => !t.skip).map((t) => t.conditionId)));
    } catch (e) { fail(e); setTargets(null); }
    finally { setBusy(false); }
  }
  async function run() {
    if (!picked.size) return;
    if (!window.confirm(`${picked.size} 件の条件に、許諾期間（3 年・3 年ごとに自動更新）を入れます。よいですか？`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ updated: number }>("/conditions/term-default", { conditionIds: [...picked] });
      setDone(`${r.updated} 件の条件に許諾期間を入れました。決定済みの条件書は下の「2」で出し直してください`);
      setTargets(null); setPicked(new Set());
      await loadDocs();
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  }
  async function loadDocs() {
    setError(null); setResults([]);
    try {
      const r = await api.get<{ targets: DocTarget[] }>("/conditions/term-default/reissue");
      setDocs(r.targets);
      setPickedDocs(new Set(r.targets.filter((t) => !t.skip).map((t) => t.documentId)));
    } catch (e) { fail(e); setDocs(null); }
  }
  async function reissue() {
    if (!pickedDocs.size) return;
    if (!window.confirm(`${pickedDocs.size} 枚の条件書を訂正版で出し直します。元の版は退きます。よいですか？`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ reissued: number; results: DocResult[] }>("/conditions/term-default/reissue",
        { documentIds: [...pickedDocs] });
      setResults(r.results);
      setDone(`${r.reissued} 枚を訂正版で出し直しました`);
      const left = await api.get<{ targets: DocTarget[] }>("/conditions/term-default/reissue");
      setDocs(left.targets);
      setPickedDocs(new Set(left.targets.filter((t) => !t.skip).map((t) => t.documentId)));
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  }
  const toggle = (set: Set<number>, id: number) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };
  const ready = (targets ?? []).filter((t) => !t.skip);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>許諾期間の入っていない条件に 3 年を入れる</h2>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>{open ? "閉じる" : "開く"}</button>
      </div>
      {open && (
        <div className="panel-bd stack">
          <div className="faint">
            出版の条件書に載っている条件で、終了日が空のものに、基本契約と同じ「開始日から 3 年（満了は 3 年後の前日）・以後 3 年ごとに
            自動更新」を入れます。開始が古い条件は、条件書の締結日までの更新の回数が「（更新 n回）」で付きます。
            開始日も空の条件は計算できないので直しません。決定済みの条件書は、直したあと「2」で訂正版として出し直します。
          </div>

          <div><b>1. 条件に許諾期間を入れる</b></div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => void tryIt()}>試算</button>
            {targets && !readOnly && (
              <button className="btn btn-sm primary" disabled={busy || !picked.size} onClick={() => void run()}>
                {picked.size} 件に入れる
              </button>
            )}
            {targets && targets.length > ready.length && (
              <span className="faint">開始日の無い {targets.length - ready.length} 件は直しません</span>
            )}
          </div>
          {error && <div className="alert">{error}</div>}
          {done && <div className="notice">{done}</div>}
          {targets && (
            <div className="tablewrap"><table>
              <thead><tr>
                <th><input type="checkbox" aria-label="全部選ぶ" checked={!!ready.length && picked.size === ready.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(ready.map((t) => t.conditionId)) : new Set())} /></th>
                <th>相手先</th><th>条件</th><th>条件書</th><th>開始日</th><th>入れる満了日</th><th>今日の時点の許諾期間</th></tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.conditionId} className={t.skip ? "faint" : ""}>
                    <td>{!t.skip && <input type="checkbox" checked={picked.has(t.conditionId)}
                      onChange={() => setPicked(toggle(picked, t.conditionId))}
                      aria-label={`${t.conditionNo ?? t.conditionId} に入れる`} />}</td>
                    <td>{t.partyName ?? "—"}</td>
                    <td className="code">{t.conditionNo ?? `#${t.conditionId}`}
                      <div className="faint" style={{ fontSize: "0.85em" }}>{t.workTitle ?? t.conditionName}</div></td>
                    <td className="faint">{t.documentNos.join("、") || "—"}</td>
                    <td>{t.termStart ?? "—"}</td>
                    <td>{t.newTermEnd ?? "—"}</td>
                    <td>{t.skip ? <span className="tag warn">{t.skip}</span> : t.label}</td>
                  </tr>
                ))}
                {!targets.length && <tr><td colSpan={7} className="faint">許諾期間の入っていない条件はありません</td></tr>}
              </tbody>
            </table></div>
          )}

          <div><b>2. 決定済みの条件書を訂正版で出し直す</b></div>
          <div className="faint">
            1 で期間を入れた条件を載せた、決定済みの条件書です。元の締結日・決定日のまま、番号に枝番（-R2 など）を付けて出し直します。
            相手先へ送ったあとの条件書なら、出し直した版を送り直してください（未送付の一覧に出ます）。
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => void loadDocs()}>出し直す条件書を見る</button>
            {docs && !readOnly && (
              <button className="btn btn-sm primary" disabled={busy || !pickedDocs.size} onClick={() => void reissue()}>
                {busy ? "出し直しています…" : `${pickedDocs.size} 枚を出し直す`}
              </button>
            )}
          </div>
          {docs && (
            <div className="tablewrap"><table>
              <thead><tr>
                <th><input type="checkbox" aria-label="全部選ぶ"
                  checked={!!docs.filter((d) => !d.skip).length && pickedDocs.size === docs.filter((d) => !d.skip).length}
                  onChange={(e) => setPickedDocs(e.target.checked ? new Set(docs.filter((d) => !d.skip).map((d) => d.documentId)) : new Set())} /></th>
                <th>相手先</th><th>条件書</th><th>決定日</th><th>期間を入れた条件</th><th>結果・注意</th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.documentId} className={d.skip ? "faint" : ""}>
                    <td>{!d.skip && <input type="checkbox" checked={pickedDocs.has(d.documentId)}
                      onChange={() => setPickedDocs(toggle(pickedDocs, d.documentId))}
                      aria-label={`${d.documentNo ?? d.documentId} を出し直す`} />}</td>
                    <td>{d.partyName ?? "—"}</td>
                    <td className="code">{d.documentNo ?? `#${d.documentId}`}</td>
                    <td>{d.issuedOn ?? "—"}</td>
                    <td className="num">{d.conditions}</td>
                    <td>
                      {d.skip && <span className="tag warn">{d.skip}</span>}
                      {d.reuseDraftId && <span className="faint">前に残った訂正版の下書き（#{d.reuseDraftId}）を決定します</span>}
                    </td>
                  </tr>
                ))}
                {!docs.length && <tr><td colSpan={6} className="faint">出し直す条件書はありません</td></tr>}
              </tbody>
            </table></div>
          )}
          {!!results.length && (
            <div className="tablewrap"><table>
              <thead><tr><th>条件書</th><th>結果</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.documentId}>
                    <td className="code">{r.documentNo ?? `#${r.documentId}`}</td>
                    <td>{r.status === "reissued"
                      ? <><span className="tag ok">済</span> {r.newDocumentNo ?? ""} で出し直しました</>
                      : <><span className="tag warn">{r.status === "skipped" ? "飛ばし" : "失敗"}</span> {r.message}</>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}
