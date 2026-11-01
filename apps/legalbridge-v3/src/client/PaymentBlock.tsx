import { useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 支払が立っていて止まったときの道案内（サーバの detail.blockingPayments を読む。server/payments/blocking.ts）。
 *
 * 「先にその支払を取り消してください」で終わると、お金の画面でその支払を探し、取り消し、元の画面に戻って
 * もう一度押すことになる。ここでは止まった場所に、どの支払か・取り消せるかを出し、
 * 「取り消して続ける」で支払を取り消してから、止まった操作をもう一度流す（onCanceled）。
 * 支払済みは取り消せないので、その旨と次の手（差額の調整）を出す。
 */

export interface BlockingPayment { id: number; paymentNo: string | null; status: string; amount: number; dueOn: string | null; paidOn: string | null }

const STATUS: Record<string, string> = { planned: "予定", approved: "承認済み", paid: "支払済み" };
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/** エラーから止めた支払を読む。無ければ null。 */
export function blockingPaymentsOf(error: unknown): BlockingPayment[] | null {
  const detail = error instanceof ApiError ? error.detail : (error as { detail?: unknown } | null)?.detail ?? error;
  const list = (detail as { blockingPayments?: unknown } | null | undefined)?.blockingPayments;
  return Array.isArray(list) && list.length ? list as BlockingPayment[] : null;
}

export function PaymentBlock({ payments, message, onCanceled, defaultReason, readOnly }: {
  payments: BlockingPayment[];
  /** 止まった理由（サーバの文）。 */
  message?: string | null;
  /** 取り消しが済んだら、止まった操作をもう一度流す。 */
  onCanceled: () => void | Promise<void>;
  defaultReason?: string;
  readOnly?: boolean;
}) {
  const [reason, setReason] = useState(defaultReason ?? "金額・数量の訂正のため");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancellable = payments.filter((p) => p.status !== "paid");
  const paid = payments.filter((p) => p.status === "paid");

  async function cancelAndGo() {
    if (!reason.trim()) { setError("取り消しの理由を入れてください"); return; }
    setBusy(true); setError(null);
    try {
      for (const p of cancellable) await api.post(`/payments/${p.id}/cancel`, { reason: reason.trim() });
      await onCanceled();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="note warn stack" style={{ gap: 6 }} role="alert">
      <b>支払が立っているので止まりました</b>
      {message && <span className="faint">{message}</span>}
      {payments.map((p) => (
        <div key={p.id} className="fix-row">
          <span className="code">{p.paymentNo ?? `#${p.id}`}</span>
          <span className={`chip ${p.status === "paid" ? "stop" : "chg"}`}>{STATUS[p.status] ?? p.status}</span>
          <span className="ba">{yen(p.amount)}</span>
          <span className="faint">{p.status === "paid" ? `支払日 ${p.paidOn ?? "—"}` : `期日 ${p.dueOn ?? "—"}`}</span>
        </div>
      ))}
      {cancellable.length > 0 && !readOnly && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="field" style={{ minWidth: 260, flex: "1 1 260px", margin: 0 }}>
            <span>取り消しの理由</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="btn primary btn-sm" disabled={busy} onClick={() => void cancelAndGo()}>
            {busy ? "取り消しています…" : `${cancellable.map((p) => p.paymentNo ?? `#${p.id}`).join("・")} を取り消して続ける`}
          </button>
        </div>
      )}
      {cancellable.length > 0 && (
        <span className="faint">取り消した支払は、直したあと（検収書の訂正版を決定したら文書の画面で）作り直します。番号は新しくなります。</span>
      )}
      {paid.length > 0 && (
        <span className="faint">支払済みの支払は取り消せません。直す前との差額は、返金・次回相殺などの調整として別に立ててください。</span>
      )}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
