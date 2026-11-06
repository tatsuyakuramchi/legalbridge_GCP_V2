import { useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 未払いの支払の源泉を、立替金（非課税・不課税）を除く規則で計算し直す（POST /payments/recompute-withholding）。
 *
 * 2026-11 に経理から「源泉が（税込金額＋立替金）で計算されている」と指摘があり、支払を立てるときの
 * 規則を直した。直す前に立てた未払いの支払は値が残っているので、ここでまとめて直す。
 *   ① 支払日を入れて「確かめる」（何も書かない）→ ② 一覧を見て「この内容で直す」。
 * 支払済み・手で直した源泉・割当が支払額と合わない支払は触らない（理由を出す）。
 */
interface Change { paymentId: number; paymentNo: string | null; party: string; dueOn: string | null; before: number; after: number; reimbursement: number }
interface Skip { paymentId: number; paymentNo: string | null; reason: string }

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

export function WithholdingFix({ defaultDueOn, onDone, gapCount = 0 }: {
  defaultDueOn?: string; onDone?: () => void;
  /** 帳票の中で「源泉が計算値と不一致」の行の数。あれば見出しに出して気づけるようにする。 */
  gapCount?: number;
}) {
  const [dueOn, setDueOn] = useState(defaultDueOn ?? "");
  const [preview, setPreview] = useState<{ changed: Change[]; skipped: Skip[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.post<{ changed: Change[]; skipped: Skip[] }>("/payments/recompute-withholding",
        { dueOn: dueOn || null, dryRun });
      if (dryRun) setPreview(r);
      else { setPreview(null); setNotice(`${r.changed.length} 件の源泉を直しました。帳票を出し直してください`); onDone?.(); }
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>源泉の計算し直し</h2>
        <span className="faint">未払いの支払の源泉を、立替金（非課税・不課税）を除いて計算し直します</span>
        {gapCount > 0 && <span className="tag out">源泉が計算値と違う行 {gapCount} 件</span>}
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        <div className="row">
          <label className="row" style={{ gap: 6 }}>
            <span className="faint">支払日</span>
            <input className="inline-input" type="date" value={dueOn} onChange={(e) => { setDueOn(e.target.value); setPreview(null); }} />
          </label>
          <button className="btn btn-sm" disabled={busy} onClick={() => run(true)}>{busy && !preview ? "確かめています…" : "確かめる（書かない）"}</button>
          <span className="faint">空なら未払いの支払ぜんぶ</span>
        </div>
        {error && <div className="alert">{error}</div>}
        {notice && <div className="note ok">{notice}</div>}
        {preview && (
          <>
            {preview.changed.length === 0
              ? <div className="faint">直す支払はありません（立替金を含む未払いの支払は、もう正しい源泉です）。</div>
              : (
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>支払番号</th><th>支払先</th><th>支払日</th><th>立替金</th><th>源泉（今）</th><th>源泉（直したあと）</th></tr></thead>
                    <tbody>
                      {preview.changed.map((c) => (
                        <tr key={c.paymentId}>
                          <td className="code">{c.paymentNo ?? `#${c.paymentId}`}</td><td>{c.party}</td><td>{c.dueOn ?? "—"}</td>
                          <td>{yen(c.reimbursement)}</td><td>{yen(c.before)}</td><td><b>{yen(c.after)}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            {preview.skipped.length > 0 && (
              <div className="faint">
                触らない支払 {preview.skipped.length} 件：{preview.skipped.map((s) => `${s.paymentNo ?? `#${s.paymentId}`}（${s.reason}）`).join("、")}
              </div>
            )}
            {preview.changed.length > 0 && (
              <div className="row">
                <button className="btn btn-sm primary" disabled={busy} onClick={() => run(false)}>この内容で直す（{preview.changed.length} 件）</button>
                <span className="faint">直した前後の値は監査記録に残ります</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
