import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

/**
 * 支払を条件へ割り当てる。
 *
 * サーバ（PUT /payments/:id/allocations）は前からあったが、画面が無かった。
 * そのため移行してきた支払はすべて未割当のまま残り、経理提出用の帳票では
 * 支払内容が空欄になり、データ品質の PAYMENT_UNALLOCATED も減らなかった。
 *
 * 差分ではなく全体を置き換える形にしてある（サーバもそう受け取る）。
 * 「足したつもりが二重になる」を起こさないため。
 */

interface Candidate {
  id: number; conditionNo: string | null; name: string;
  direction: string; currency: string;
  flatAmount: number | null; alreadyAllocated: number;
}

export interface AllocationTarget {
  id: number; paymentNo: string | null; currency: string; amount: number;
  partyName: string; dueOn: string | null;
  allocations: Array<{ conditionNo: string | null; amount: number }>;
}

export function PaymentAllocation(
  { payment, onClose, onSaved }:
  { payment: AllocationTarget; onClose: () => void; onSaved: () => void }
) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    api.get<{ candidates: Candidate[] }>(`/payments/${payment.id}/allocation-candidates`)
      .then((r) => {
        setCandidates(r.candidates);
        // すでに割り当ててある分を初期値にする。開いただけで消えないように。
        const seeded: Record<number, string> = {};
        for (const c of r.candidates) {
          const existing = payment.allocations.find((a) => a.conditionNo && a.conditionNo === c.conditionNo);
          if (existing) seeded[c.id] = String(existing.amount);
        }
        setAmounts(seeded);
      })
      .catch((e: ApiError) => { setError(e.message); setCandidates([]); });
  }, [payment.id]);

  const lines = Object.entries(amounts)
    .map(([id, raw]) => ({ conditionId: Number(id), amount: Math.round(Number(raw) || 0) }))
    .filter((l) => l.amount !== 0);
  const allocated = lines.reduce((sum, l) => sum + l.amount, 0);
  const remain = payment.amount - allocated;
  const over = remain < 0;

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.put(`/payments/${payment.id}/allocations`, { lines });
      onSaved();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /** 未割当を、まだ入っていない先頭の候補へ寄せる。手入力の手間を減らすだけ。 */
  function fillRest() {
    if (!candidates?.length || remain <= 0) return;
    const target = candidates.find((c) => !Number(amounts[c.id] || 0)) ?? candidates[0];
    setAmounts({ ...amounts, [target.id]: String((Number(amounts[target.id] || 0)) + remain) });
  }

  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>支払の割当</h2>
        <span className="code">{payment.paymentNo ?? `#${payment.id}`}</span>
        <span className="faint">{payment.partyName}</span>
        <span className="faint" style={{ marginLeft: "auto" }}>期日 {payment.dueOn ?? "—"}</span>
      </div>

      <div className="panel-bd stack">
        <div className="row" style={{ gap: 22 }}>
          <div>
            <div className="faint">支払額（税抜）</div>
            <div className="num" style={{ fontSize: 18 }}>{money(payment.amount, payment.currency)}</div>
          </div>
          <div>
            <div className="faint">割当済み</div>
            <div className="num" style={{ fontSize: 18 }}>{money(allocated, payment.currency)}</div>
          </div>
          <div>
            <div className="faint">未割当</div>
            <div className="num" style={{ fontSize: 18, color: over ? "var(--out)" : remain === 0 ? "var(--ok)" : "var(--out)" }}>
              {over ? `▲${money(-remain, payment.currency)}` : money(remain, payment.currency)}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div className="meter">
              <i style={{
                width: `${Math.max(0, Math.min(100, payment.amount ? (allocated / payment.amount) * 100 : 0))}%`,
                background: over ? "var(--out)" : remain === 0 ? "var(--ok)" : "var(--in)"
              }} />
            </div>
            <div className="faint" style={{ marginTop: 4 }}>
              {over ? "支払額を超えています" : remain === 0 ? "すべて割り当てられています" : "未割当が残っています"}
            </div>
          </div>
        </div>

        {error && <div className="alert">{error}</div>}

        {candidates === null ? (
          <div className="faint">候補を読み込んでいます…</div>
        ) : !candidates.length ? (
          <div className="note warn">
            割当先の候補がありません。候補に出るのは<b>この支払の相手先と同じ、通貨も同じ、有効な条件</b>だけです。
            相手先の取り違え・通貨違い・条件が終了している場合は出ません。
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>条件番号</th><th>内容</th><th className="num">条件の金額</th>
                <th className="num">既存の割当</th><th className="num">この支払から</th>
              </tr></thead>
              <tbody>
                {candidates.map((c) => {
                  const value = amounts[c.id] ?? "";
                  const active = Number(value) > 0;
                  return (
                    <tr key={c.id} className={active ? "sel" : ""}>
                      <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                      <td>{c.name}
                        <div className="faint">{c.direction === "in" ? "IN 取得" : "OUT 許諾"} ／ {c.currency}</div>
                      </td>
                      <td className="num">{c.flatAmount === null ? "—" : money(c.flatAmount, c.currency)}</td>
                      <td className="num faint">
                        {c.alreadyAllocated ? money(c.alreadyAllocated, c.currency) : "—"}
                      </td>
                      <td className="num">
                        <input className="inline-input" inputMode="numeric" value={value}
                          aria-label={`${c.conditionNo ?? c.name} への割当額`}
                          onChange={(e) => setAmounts({
                            ...amounts, [c.id]: e.target.value.replace(/[^0-9]/g, "")
                          })} />
                        <div className="faint">{value ? money(Number(value), c.currency) : "　"}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="row">
          <button className="btn primary" disabled={busy || over} onClick={() => void save()}>
            {busy ? "保存中…" : "保存する"}
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
          {candidates?.length ? (
            <button className="btn" onClick={fillRest} disabled={busy || remain <= 0}>残りを寄せる</button>
          ) : null}
          <span className="faint">
            {over ? "合計が支払額を超えています。保存できません"
              : remain === 0 ? "経理提出用の帳票に支払内容が入ります"
              : "未割当のままでも保存できます（帳票には「割当なし」の印が付きます）"}
          </span>
        </div>

        <p className="faint" style={{ margin: 0 }}>
          差分ではなく全体を置き換えます。0円の行は外れます。同じ条件を二重に入れることはできません。
        </p>
      </div>
    </div>
  );
}
