import { useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 個人への支払日を 20 日に揃える（すでに立っている回）。
 *
 * 個人への支払は 20 日が当社の決まり。新しく立てる回はそう出るが、決まりを入れる前に立てた回は
 * 支払条件の「末日」のまま。相手先が個人で、支払日が月の末日の回を、同じ月の 20 日に直す。
 * 決定済みの文書や支払が出ている回・支払日が過去の回は直さない（紙に刷ってある日は訂正版で）。
 */
interface Target {
  scheduleId: number; conditionId: number; conditionNo: string | null; conditionName: string;
  partyName: string | null; label: string | null; payOn: string; newPayOn: string;
}

export function IndividualPayDay() {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function tryIt() {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.get<{ targets: Target[] }>("/schedules/individual-pay-day");
      setTargets(r.targets);
      setPicked(new Set(r.targets.map((t) => t.scheduleId)));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setTargets(null); }
    finally { setBusy(false); }
  }
  async function run() {
    if (!picked.size) return;
    if (!window.confirm(`${picked.size} 回の支払日を 20 日に直します。よいですか？`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ updated: number }>("/schedules/individual-pay-day", { scheduleIds: [...picked] });
      setDone(`${r.updated} 回の支払日を 20 日に直しました`); setTargets(null); setPicked(new Set());
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const toggle = (id: number) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>個人への支払日を 20 日に揃える</h2>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>{open ? "閉じる" : "開く"}</button>
      </div>
      {open && (
        <div className="panel-bd stack">
          <div className="faint">
            個人への支払は 20 日（支払条件の「…末日」を同じ月の 20 日に）。決まりを入れる前に立てた回は末日のままなので、
            相手先が個人で支払日が月の末日の回を 20 日に直します。決定済みの文書や支払が出ている回、支払日が過ぎた回は直しません
            （紙に刷った支払期日は訂正版で直してください）。共著の取り分で、相手先が法人・受取人が個人の回は対象外です。
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => void tryIt()}>試算</button>
            {targets && !readOnly && (
              <button className="btn btn-sm primary" disabled={busy || !picked.size} onClick={() => void run()}>
                {picked.size} 回を 20 日に直す
              </button>
            )}
          </div>
          {error && <div className="alert">{error}</div>}
          {done && <div className="notice">{done}</div>}
          {targets && (
            <div className="tablewrap"><table>
              <thead><tr>
                <th><input type="checkbox" aria-label="全部選ぶ" checked={!!targets.length && picked.size === targets.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(targets.map((t) => t.scheduleId)) : new Set())} /></th>
                <th>相手先</th><th>条件</th><th>回</th><th>いまの支払日</th><th>直したあと</th></tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.scheduleId}>
                    <td><input type="checkbox" checked={picked.has(t.scheduleId)} onChange={() => toggle(t.scheduleId)}
                      aria-label={`${t.conditionNo ?? t.conditionId} ${t.label ?? ""} を直す`} /></td>
                    <td>{t.partyName ?? "—"}</td>
                    <td className="code">{t.conditionNo ?? `#${t.conditionId}`}<div className="faint" style={{ fontSize: "0.85em" }}>{t.conditionName}</div></td>
                    <td>{t.label ?? "—"}</td>
                    <td>{t.payOn}</td>
                    <td>{t.newPayOn}</td>
                  </tr>
                ))}
                {!targets.length && <tr><td colSpan={6} className="faint">直す回はありません</td></tr>}
              </tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}
