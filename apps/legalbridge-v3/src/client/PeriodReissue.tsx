import { useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { OwnerStaffPicker } from "./OwnerStaffPicker.js";

/**
 * 出した計算書の一括の出し直し（対象期間・担当者・個人宛ての支払日・共著の取り分の表示・源泉）。
 * 運用 › 一括修正 に置く。訂正版でまとめて出し直し、額は変えない。
 */
type ReissueStatus = "change" | "same" | "no_round" | "amount" | "draft" | "error";
interface ReissueTarget {
  documentId: number; documentNo: string | null; issuedOn: string | null; templateKey: string;
  partyName: string | null; conditionCount: number; currentLabel: string | null; newLabel: string | null;
  reasons: Array<"period" | "staff" | "payday" | "share" | "withholding">; currentPayOn: string | null; newPayOn: string | null;
  status: ReissueStatus; message: string | null;
  newDocumentId?: number | null; newDocumentNo?: string | null; paymentsUpdated?: number;
}
const REASON_LABEL = { period: "対象期間", staff: "担当者", payday: "支払日", share: "取り分の表示", withholding: "源泉" } as const;
const REISSUE_STATUS: Record<ReissueStatus, string> = {
  change: "出し直す", same: "直すものなし", no_round: "回が無い", amount: "額が変わる", draft: "下書きあり", error: "出せない"
};

/**
 * 出した計算書の対象期間を、回の期間（「2025年7月〜2026年6月」）に揃えて訂正版で出し直す。
 * まとめて締めるの計算書は売上のあった月の範囲で期間を出していて、作品・受取人ごとにばらついていた。
 */
export function PeriodReissuePanel() {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<"pub_digital" | "pub_print">("pub_digital");
  const [targets, setTargets] = useState<ReissueTarget[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  /** 空なら直す理由から組む（「対象期間の表記を回の期間に揃える・担当者を記載する」など）。 */
  const [reason, setReason] = useState("");
  /** 訂正版の担当者。選ばなければ元の計算書の担当のまま。 */
  const [ownerStaffId, setOwnerStaffId] = useState<number | null>(null);
  /** 個人宛ての計算書の支払日を 20 日にする（回と未払いの支払の期日も直す）。 */
  const [payDay, setPayDay] = useState(false);
  const [done, setDone] = useState<{ results: ReissueTarget[]; reissued: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function tryIt() {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ targets: ReissueTarget[] }>("/royalty-ledger/statements/period-reissue/preview",
        { usageType: usage, ownerStaffId, individualPayDay: payDay });
      setTargets(r.targets);
      setPicked(new Set(r.targets.filter((t) => t.status === "change").map((t) => t.documentId)));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setTargets(null); }
    finally { setBusy(false); }
  }
  async function run() {
    if (!picked.size) return;
    if (!window.confirm(`${picked.size} 枚の計算書を訂正版で出し直します。元の計算書は差し替え済みになり、番号は改訂の番号になります。`
      + (payDay ? "個人宛ては回の支払日と未払いの支払の期日も 20 日に直します。" : "")
      + "相手に送り直す必要があります。よいですか？")) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ results: ReissueTarget[]; reissued: number }>("/royalty-ledger/statements/period-reissue",
        { usageType: usage, documentIds: [...picked], reason: reason.trim() || null, ownerStaffId, individualPayDay: payDay });
      setDone(r); setTargets(null); setPicked(new Set());
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const toggle = (id: number) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const shown = (targets ?? []).filter((t) => showAll || t.status !== "same");
  const failed = done?.results.filter((r) => r.status === "error") ?? [];

  return (
    <div className="subpanel">
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <button className="btn btn-sm" onClick={() => setOpen(!open)}>{open ? "閉じる" : "出した計算書を出し直す（対象期間・担当者・支払日・取り分の表示・源泉）"}</button>
        <span className="faint">対象期間を回の期間に揃える・担当者を入れる・個人宛ての支払日を 20 日にする・共著の取り分の計算（料率×取り分）を載せる・源泉を 1 枚の合計で計算し直す。訂正版でまとめて出し直します</span>
      </div>
      {open && (
        <div className="stack" style={{ marginTop: 8 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
            <label className="field"><span>媒体</span>
              <select value={usage} onChange={(e) => { setUsage(e.target.value as "pub_digital" | "pub_print"); setTargets(null); }}>
                <option value="pub_digital">電子出版</option>
                <option value="pub_print">紙出版</option>
              </select>
            </label>
            <div className="field" style={{ minWidth: 260 }}><span>担当者を入れる</span>
              <OwnerStaffPicker value={ownerStaffId} onChange={(v) => { setOwnerStaffId(v); setTargets(null); }} disabled={busy}
                emptyLabel="入れない（元の計算書の担当のまま）" />
            </div>
            <label className="row" style={{ gap: 6, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={payDay} disabled={busy} onChange={(e) => { setPayDay(e.target.checked); setTargets(null); }} />
              個人宛ては支払日を 20 日にする
            </label>
            <label className="field" style={{ minWidth: 260 }}><span>訂正の理由（空なら直す中身から）</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="対象期間の表記を回の期間に揃える・担当者を記載する" />
            </label>
            <button className="btn btn-sm" disabled={busy} onClick={() => void tryIt()}>試算</button>
            {targets && !readOnly && (
              <button className="btn btn-sm primary" disabled={busy || !picked.size} onClick={() => void run()}>
                {picked.size} 枚を出し直す
              </button>
            )}
            {targets && (
              <label className="row" style={{ gap: 6, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                直すものの無い計算書も出す
              </label>
            )}
            {busy && <span className="faint">処理中…</span>}
          </div>
          <div className="faint">
            発行済みの計算書は書き換えず、訂正版を出して元を差し替え済みにします（実績は訂正版に移ります）。条件・受取人・実績・決定日は元のまま、額も変えません。いま計算し直して額が変わる計算書は出し直しません（個別に訂正してください）。支払は作り直しません。出し直した計算書は相手に送り直してください。
            担当者を選ぶと、担当が違う計算書と、担当の行の無い古いひな形で出した計算書も出し直します。
            「支払日を 20 日に」は、個人宛てで回の支払日が月の末日（まだ来ていない）の計算書が対象です。回の支払日と、元の計算書から立っている未払いの支払の期日も 20 日に直します。支払済みの計算書は支払日を直しません
          </div>
          {error && <div className="alert">{error}</div>}
          {done && (
            <div className="notice">
              {done.reissued} 枚を出し直しました
              {done.results.some((r) => r.paymentsUpdated) && `（支払の期日を直した支払 ${done.results.reduce((n, r) => n + (r.paymentsUpdated ?? 0), 0)} 件）`}
              {done.results.filter((r) => r.newDocumentNo).length > 0 && (
                <div className="faint" style={{ fontSize: "0.85em" }}>
                  {done.results.filter((r) => r.newDocumentNo).map((r) => `${r.documentNo ?? `#${r.documentId}`} → ${r.newDocumentNo}`).join("、")}
                </div>
              )}
              {failed.length > 0 && (
                <div className="alert" style={{ marginTop: 6 }}>
                  出せなかった計算書：{failed.map((r) => `${r.documentNo ?? `#${r.documentId}`}（${r.message ?? ""}）`).join("、")}
                </div>
              )}
            </div>
          )}
          {targets && (
            <div className="tablewrap">
              <table>
                <thead><tr><th></th><th>計算書</th><th>決定日</th><th>宛先</th><th>条件</th><th>直すもの</th><th>いまの対象期間</th><th>出し直したあと</th><th>支払期日</th><th>状態</th></tr></thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.documentId} className={t.status === "change" ? "" : "faint"}>
                      <td><input type="checkbox" disabled={t.status !== "change"} checked={picked.has(t.documentId)}
                                 onChange={() => toggle(t.documentId)} aria-label={`${t.documentNo ?? t.documentId} を出し直す`} /></td>
                      <td className="code">{t.documentNo ?? `#${t.documentId}`}</td>
                      <td>{t.issuedOn ?? "—"}</td>
                      <td>{t.partyName ?? "—"}</td>
                      <td className="num">{t.conditionCount}</td>
                      <td>{(t.reasons ?? []).map((r) => REASON_LABEL[r]).join("・") || "—"}</td>
                      <td>{t.currentLabel ?? "—"}</td>
                      <td>{t.newLabel ?? "—"}</td>
                      <td>{t.newPayOn ? `${t.currentPayOn ?? "—"} → ${t.newPayOn}` : (t.currentPayOn ?? "—")}</td>
                      <td>{REISSUE_STATUS[t.status]}{t.message ? <div className="faint" style={{ fontSize: "0.85em" }}>{t.message}</div> : null}</td>
                    </tr>
                  ))}
                  {!shown.length && <tr><td colSpan={10} className="faint">出し直す計算書はありません</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
