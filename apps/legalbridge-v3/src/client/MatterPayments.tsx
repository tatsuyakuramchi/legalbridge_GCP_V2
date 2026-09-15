import { useState } from "react";
import type { MatterDetail } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import { CreateForm, int, text } from "./CreateForm.js";
import { CONDITION_KIND_LABEL, StatusTag } from "./labels.js";

/**
 * 案件の画面から支払を立てる。
 *
 * 支払は案件に属さない（複数案件をまたぐ）ので、案件からは「割当の付いた条件」
 * 経由で見える。だからここで立てる支払は必ず条件か文書（＝実績）に繋ぐ。
 * 2つの口がある：
 *  - 決定済みの検収書・計算書から起こす（実績の額で、割当は自動）。
 *  - 案件の条件に宛てて手で起こす（額を打つ。全額がその条件に割り当たる）。
 * 起こした支払は「支払済みにする」「取り消す」までここで済む。
 */

/** 実績から支払を起こせるひな形。検収書と計算書。 */
const SETTLEABLE = /inspection|acceptance|delivery|statement|royalty/;
const today = () => new Date().toISOString().slice(0, 10);

export function MatterPayments(
  { detail, onChanged, onOpenDocument }: {
    detail: MatterDetail;
    onChanged: () => void;
    onOpenDocument?: (documentId: number) => void;
  }
) {
  const [mode, setMode] = useState<null | "document" | "condition">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dueOn, setDueOn] = useState("");

  const live = detail.conditions.filter((c) => c.status !== "void" && c.status !== "superseded");
  const settleable = detail.documents.filter((d) =>
    (d.status === "issued" || d.status === "sent") && SETTLEABLE.test(d.templateKey ?? ""));
  const first = live[0] ?? null;

  async function fromDocument(documentId: number, label: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.post<{ paymentId: number; dueOn: string | null; direction: string;
                                 due?: { verdict: string; limitDate?: string | null } }>(
        `/documents/${documentId}/payment`, { dueOn: dueOn || null });
      setNotice(`${label} から支払 #${r.paymentId} を起こしました（${r.direction === "in" ? "入金" : "支払"}／期日 ${r.dueOn ?? "未定"}）`
        + (r.due?.verdict === "over_limit" ? `。期日が受領日+60日（${r.due.limitDate ?? ""}）を超えています` : ""));
      setMode(null); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function markPaid(p: MatterDetail["payments"][number]) {
    if (!confirm(`${p.paymentNo ?? `#${p.id}`} を今日（${today()}）の支払済みにします。`)) return;
    setBusy(true); setError(null);
    try { await api.post(`/payments/${p.id}/paid`, { paidOn: today() }); onChanged(); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function cancel(p: MatterDetail["payments"][number]) {
    const reason = prompt(`${p.paymentNo ?? `#${p.id}`} を取り消します。理由を書いてください。`);
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    try { await api.post(`/payments/${p.id}/cancel`, { reason: reason.trim() }); onChanged(); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      {!mode && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <button className="btn btn-sm primary" disabled={!settleable.length}
                  title={settleable.length ? "決定済みの検収書・計算書の実績から、額と割当を自動で起こす"
                                           : "決定済みの検収書・計算書がこの案件にありません"}
                  onClick={() => { setMode("document"); setNotice(null); }}>
            文書（検収書・計算書）から支払を起こす
          </button>
          <button className="btn btn-sm" disabled={!live.length}
                  title="額を打って、この案件の条件に宛てて起こす。全額がその条件に割り当たる"
                  onClick={() => { setMode("condition"); setNotice(null); }}>
            条件に宛てて支払を起こす
          </button>
        </div>
      )}

      {mode === "document" && (
        <div className="note stack" style={{ gap: 8 }}>
          <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <b>文書から支払を起こす</b>
            <span className="faint">額・相手先・割当はその文書の実績から決まる</span>
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setMode(null)}>やめる</button>
          </div>
          <label className="row" style={{ alignItems: "center", gap: 8 }}>
            <span className="faint">支払期日（空なら紙の期日か受領日+60日）</span>
            <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </label>
          <table>
            <thead><tr><th>文書番号</th><th>ひな形</th><th>相手先</th><th></th></tr></thead>
            <tbody>
              {settleable.map((d) => (
                <tr key={d.id}>
                  <td className="code" style={{ whiteSpace: "nowrap" }}>
                    {onOpenDocument
                      ? <button className="btn btn-sm" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                      : (d.documentNo ?? `#${d.id}`)}
                  </td>
                  <td>{d.templateLabel ?? d.templateKey}</td>
                  <td>{d.counterparty ?? "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm primary" disabled={busy}
                            onClick={() => void fromDocument(d.id, d.documentNo ?? `#${d.id}`)}>
                      この文書から起こす
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="faint">
            同じ実績に二重には立ちません（先の支払を取り消してから立て直す）。
          </span>
        </div>
      )}

      {mode === "condition" && first && (
        <CreateForm
          title="条件に宛てて支払を起こす"
          submitLabel="支払を起こす"
          path="/payments"
          initial={{ conditionId: String(first.id), direction: first.direction === "out" ? "in" : "out",
                     currency: first.currency, dueOn: "" }}
          fields={[
            { name: "conditionId", label: "宛先の条件", type: "select", required: true,
              options: live.map((c) => ({
                value: String(c.id),
                label: `${c.conditionNo ?? `#${c.id}`} ／ ${CONDITION_KIND_LABEL[c.kind] ?? c.kind} ／ ${c.name}`
                  + (c.counterparty ? ` ／ ${c.counterparty.name}` : "")
              })),
              hint: "相手先はこの条件の相手先。税抜額の全部がこの条件に割り当たる" },
            { name: "direction", label: "向き", type: "select", required: true,
              options: [{ value: "out", label: "支払う（取得の条件）" }, { value: "in", label: "受け取る（許諾の条件）" }] },
            { name: "amount", label: "税抜金額（最小通貨単位）", type: "money", required: true,
              hint: "円なら円単位。¥330,000 は 330000" },
            { name: "taxAmount", label: "消費税", type: "money" },
            { name: "withholdingAmount", label: "源泉徴収", type: "money" },
            { name: "currency", label: "通貨", type: "select", required: true,
              options: [{ value: "JPY", label: "JPY 円" }, { value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }] },
            { name: "basisReceivedOn", label: "給付を受領した日", type: "date",
              hint: "取適法の起算点。個人相手の支払では期日の検査に使う" },
            { name: "dueOn", label: "支払期日", type: "date" },
            { name: "note", label: "摘要", type: "textarea" }
          ]}
          toPayload={(v) => ({
            conditionId: int(v.conditionId), direction: v.direction, amount: int(v.amount) ?? 0,
            taxAmount: int(v.taxAmount), withholdingAmount: int(v.withholdingAmount),
            currency: v.currency || "JPY",
            basisReceivedOn: text(v.basisReceivedOn), dueOn: text(v.dueOn), note: text(v.note)
          })}
          onDone={(r: { paymentNo: string }) => {
            setMode(null); setNotice(`${r.paymentNo} を起こしました`); onChanged();
          }}
          onCancel={() => setMode(null)}
        >
          <p className="faint">
            相手先が個人（特定受託事業者）なら、受領日から60日を超える期日では登録できない。
            実績のある支払は、上の「文書から」で起こすと額と割当が自動で合う。
          </p>
        </CreateForm>
      )}

      {error && <div className="alert">{error}</div>}
      {notice && <div className="done-note">{notice}</div>}

      <table>
        <thead><tr><th>支払番号</th><th>向き</th><th className="num">金額</th><th>期日</th><th>状態</th><th></th></tr></thead>
        <tbody>
          {detail.payments.map((p) => (
            <tr key={p.id}>
              <td className="code">{p.paymentNo ?? `#${p.id}`}</td>
              <td>{p.direction === "in" ? "入金" : "支払"}</td>
              <td className="num">{money(p.amount, p.currency)}</td>
              <td className="code">{p.dueOn ?? "—"}</td>
              <td><StatusTag kind="payment" value={p.status} /></td>
              <td style={{ whiteSpace: "nowrap" }}>
                {p.status === "planned" && (
                  <span className="row" style={{ gap: 4 }}>
                    <button className="btn btn-sm" disabled={busy} title="今日の日付で支払済みにする"
                            onClick={() => void markPaid(p)}>支払済み</button>
                    <button className="btn btn-sm" disabled={busy} title="行は残し、理由を付けて取り消す"
                            onClick={() => void cancel(p)}>取消</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
          {!detail.payments.length && (
            <tr><td colSpan={6} className="faint">
              支払はありません。決定済みの検収書・計算書があれば「文書から支払を起こす」、
              無ければ「条件に宛てて支払を起こす」で立てます。
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
