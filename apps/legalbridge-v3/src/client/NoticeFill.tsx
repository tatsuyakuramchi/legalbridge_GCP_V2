import { useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { OwnerStaffPicker } from "./OwnerStaffPicker.js";

/**
 * 通知先の空いた契約書（出版の基本契約書・条件書）を、通知先を入れて訂正版で出し直す。
 *
 * 契約なしから一括で作った契約書は通知先が空のまま決定されていた。甲（相手先）は取引先の主担当
 * （個人は本人）、乙（当社）は選んだ担当者を、空いた欄にだけ入れる。元の締結日・決定日のまま出し直す。
 */
interface Target {
  documentId: number; documentNo: string | null; kind: "terms" | "master"; partyName: string | null;
  issuedOn: string | null; fills: Array<{ field: string; label: string; value: string }>;
  skip: string | null; reuseDraftId: number | null;
}
interface Result {
  documentId: number; documentNo: string | null; status: "reissued" | "skipped" | "error";
  newDocumentNo?: string | null; message?: string;
}

export function NoticeFill() {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState<number | null>(null);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Result[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(id = staffId) {
    setBusy(true); setError(null);
    try {
      const r = await api.get<{ targets: Target[] }>(`/notice-fill${id ? `?ownerStaffId=${id}` : ""}`);
      setTargets(r.targets);
      setPicked(new Set(r.targets.filter((t) => !t.skip).map((t) => t.documentId)));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setTargets(null); }
    finally { setBusy(false); }
  }
  async function run() {
    if (!picked.size) return;
    if (!window.confirm(`${picked.size} 枚の契約書を、通知先を入れた訂正版で出し直します。元の版は退きます。よいですか？`)) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ reissued: number; results: Result[] }>("/notice-fill",
        { documentIds: [...picked], ownerStaffId: staffId });
      setResults(r.results);
      setDone(`${r.reissued} 枚を訂正版で出し直しました`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
    await load();
  }
  const ready = (targets ?? []).filter((t) => !t.skip);
  const toggle = (id: number) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>通知先の空いた契約書を出し直す</h2>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>{open ? "閉じる" : "開く"}</button>
      </div>
      {open && (
        <div className="panel-bd stack">
          <div className="faint">
            決定済みの出版の基本契約書・条件書で、通知先が空いているものです。空いた欄にだけ入れ、元の締結日・決定日のまま
            訂正版（-R2 など）で出し直します。甲（相手先）と基本契約書の通知先は、個人は本人、法人は主担当（いなければ代表者の
            肩書・氏名と取引先のメール・電話）。
            条件書の乙（当社）は下で選んだ担当者（部署・氏名・メール・電話）で、条件書の担当者にもなります。
            相手先へ送ったあとの契約書なら、出し直した版を送り直してください（未送付の一覧に出ます）。
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className="faint">乙（当社）の通知先</span>
            <div style={{ minWidth: 260 }}>
              <OwnerStaffPicker value={staffId} disabled={busy} emptyLabel="選ばない（乙の空いた条件書は出し直さない）"
                onChange={(id) => { setStaffId(id); if (targets) void load(id); }} />
            </div>
            <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>試算</button>
            {targets && !readOnly && (
              <button className="btn btn-sm primary" disabled={busy || !picked.size} onClick={() => void run()}>
                {busy ? "出し直しています…" : `${picked.size} 枚を出し直す`}
              </button>
            )}
          </div>
          {error && <div className="alert">{error}</div>}
          {done && <div className="notice">{done}</div>}
          {targets && (
            <div className="tablewrap"><table>
              <thead><tr>
                <th><input type="checkbox" aria-label="全部選ぶ" checked={!!ready.length && picked.size === ready.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(ready.map((t) => t.documentId)) : new Set())} /></th>
                <th>相手先</th><th>契約書</th><th>決定日</th><th>入れる通知先</th></tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.documentId} className={t.skip ? "faint" : ""}>
                    <td>{!t.skip && <input type="checkbox" checked={picked.has(t.documentId)}
                      onChange={() => toggle(t.documentId)}
                      aria-label={`${t.documentNo ?? t.documentId} を出し直す`} />}</td>
                    <td>{t.partyName ?? "—"}</td>
                    <td className="code">{t.documentNo ?? `#${t.documentId}`}
                      <div className="faint" style={{ fontSize: "0.85em" }}>{t.kind === "master" ? "基本契約書" : "条件書"}</div></td>
                    <td>{t.issuedOn ?? "—"}</td>
                    <td>
                      {t.fills.map((f) => <div key={f.field}><span className="faint">{f.label}</span>　{f.value}</div>)}
                      {t.skip && <span className="tag warn">{t.skip}</span>}
                      {t.reuseDraftId && <div className="faint">前に残った訂正版の下書き（#{t.reuseDraftId}）を決定します</div>}
                    </td>
                  </tr>
                ))}
                {!targets.length && <tr><td colSpan={5} className="faint">通知先の空いた契約書はありません</td></tr>}
              </tbody>
            </table></div>
          )}
          {!!results.length && (
            <div className="tablewrap"><table>
              <thead><tr><th>契約書</th><th>結果</th></tr></thead>
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
