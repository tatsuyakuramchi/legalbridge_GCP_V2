import { useEffect, useMemo, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { SearchSelect, type SearchOption } from "./SearchSelect.js";

/**
 * 発注書から検収書・役務提供完了通知書を作る（server/documents/from-order.ts）。
 *
 *   ① 発注書を選ぶ（番号・件名・相手先で探す）
 *   ② 載せる実績（納品・役務の記録）を選ぶ。載る条件は発注書に結んだ条件だけ
 *   ③ 実費・手数料ごとに「かかった（実額）／今回はかからなかった／かからなかった（以後も発生しない）」
 *      発注書に無かった実費（追加の交通費など）も足せる
 *   ④ 下書きを作る → 文書の画面で確かめて決定
 *
 * 委託料の条件から作ると、独立した実費の条件が選ばれず交通費が漏れていた。発注書から引けば組が揃う。
 * 実費は発注書の見込みの額をそのまま刷らない（かかった額だけを載せる）。
 */

interface OrderEvent { id: number; occurredOn: string | null; amount: number; quantity: number | null; label: string | null; documentNo: string | null }
interface OrderLine {
  conditionId: number; conditionNo: string | null; name: string; kind: string; currency: string;
  amount: number | null; events: OrderEvent[]; openEvents: number; settled: boolean;
}
interface OrderExtra {
  conditionId: number; conditionNo: string | null; kind: "expense" | "fee"; name: string; currency: string;
  plannedAmount: number | null; settled: boolean; closed: boolean;
}
interface Plan {
  order: { id: number; documentNo: string | null; title: string | null; templateKey: string; issuedOn: string | null;
           counterparty: { id: number; name: string } | null };
  templateKey: string; templateLabel: string;
  lines: OrderLine[]; extras: OrderExtra[]; warnings: string[];
}
type ExtraStatus = "incurred" | "skip" | "none";
interface ExtraRow {
  key: string; conditionId: number | null; kind: "expense" | "fee"; name: string; status: ExtraStatus;
  amount: string; spentOn: string; remarks: string; planned: number | null; conditionNo: string | null;
}

const TEMPLATES: Array<{ key: string; label: string }> = [
  { key: "inspection_certificate", label: "検収書" },
  { key: "service_completion_notice", label: "役務提供完了通知書" },
  { key: "intl_inspection_certificate", label: "検収書（海外）" }
];

const searchOrders = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ orders: Array<{ id: number; documentNo: string | null; title: string | null; counterparty: string | null; issuedOn: string | null }> }>(
    `/orders/search?q=${encodeURIComponent(q)}`);
  return r.orders.map((o) => ({
    value: String(o.id), label: `${o.documentNo ?? `#${o.id}`}　${o.title ?? ""}`,
    hint: [o.counterparty, o.issuedOn].filter(Boolean).join("・") || null
  }));
};

export function OrderSettlement({ onOpenDraft, initialOrderId }: {
  onOpenDraft: (id: number) => void;
  initialOrderId?: number | null;
}) {
  const [orderId, setOrderId] = useState(initialOrderId ? String(initialOrderId) : "");
  const [orderLabel, setOrderLabel] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [templateKey, setTemplateKey] = useState("");
  const [events, setEvents] = useState<Set<number>>(new Set());
  const [extras, setExtras] = useState<ExtraRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orderId) { setPlan(null); return; }
    let live = true;
    setError(null);
    api.get<Plan>(`/orders/${orderId}/settlement-plan`).then((p) => {
      if (!live) return;
      setPlan(p);
      // 発注書の画面から来たときは欄に名前が無い（id だけ）。番号と件名を出す。
      setOrderLabel((prev) => prev ?? `${p.order.documentNo ?? `#${p.order.id}`}　${p.order.title ?? ""}`);
      setTemplateKey(p.templateKey);
      // 選べる実績は既定で全部選ぶ（決済文書に結んでいないもの）。
      setEvents(new Set(p.lines.flatMap((l) => l.events.filter((e) => !e.documentNo).map((e) => e.id))));
      // 決済済み・完了扱いの実費は出さない。残りは「かかった（見込みの額）」から始める。
      setExtras(p.extras.filter((x) => !x.settled && !x.closed).map((x) => ({
        key: `c${x.conditionId}`, conditionId: x.conditionId, kind: x.kind, name: x.name, status: "incurred",
        amount: x.plannedAmount ? String(x.plannedAmount) : "", spentOn: "", remarks: "",
        planned: x.plannedAmount, conditionNo: x.conditionNo
      })));
    }).catch((e) => { if (live) { setPlan(null); setError(e instanceof ApiError ? e.message : String(e)); } });
    return () => { live = false; };
  }, [orderId]);

  const currency = plan?.lines[0]?.currency ?? plan?.extras[0]?.currency ?? "JPY";
  const total = useMemo(() => {
    if (!plan) return { main: 0, extra: 0 };
    const main = plan.lines.flatMap((l) => l.events).filter((e) => events.has(e.id)).reduce((s, e) => s + e.amount, 0);
    const extra = extras.filter((x) => x.status === "incurred").reduce((s, x) => s + (Number(x.amount) || 0), 0);
    return { main, extra };
  }, [plan, events, extras]);

  const setExtra = (key: string, patch: Partial<ExtraRow>) =>
    setExtras((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const addExtra = (kind: "expense" | "fee") =>
    setExtras((xs) => [...xs, { key: `n${Date.now()}`, conditionId: null, kind, name: kind === "expense" ? "交通費" : "",
                               status: "incurred", amount: "", spentOn: "", remarks: "", planned: null, conditionNo: null }]);

  const unanswered = extras.filter((x) => x.status === "incurred" && !(Number(x.amount) > 0));

  async function create() {
    if (!plan) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/orders/${plan.order.id}/settlement-draft`, {
        templateKey, eventIds: [...events],
        extras: extras.filter((x) => x.conditionId !== null || x.status === "incurred").map((x) => ({
          conditionId: x.conditionId, kind: x.kind, name: x.name, status: x.status,
          amount: x.status === "incurred" ? Number(x.amount) || 0 : null,
          spentOn: x.spentOn || null, remarks: x.remarks || null
        }))
      });
      onOpenDraft(r.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>発注書から検収書・役務提供完了通知書を作る</h2>
        <span className="faint">載せる条件は発注書に結んだ条件だけ。実費・手数料は、かかった額だけを載せます</span>
      </div>
      <div className="panel-bd stack">
        <label className="field" style={{ maxWidth: 560 }}>
          <span>① 発注書</span>
          <SearchSelect value={orderId} valueLabel={orderLabel} search={searchOrders}
                        placeholder="発注番号・件名・相手先で探す"
                        onChange={(v, o) => { setOrderId(v); setOrderLabel(o?.label ?? null); }} />
        </label>

        {error && <div className="alert">{error}</div>}

        {plan && (
          <>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
              <b>{plan.order.documentNo}</b>
              <span>{plan.order.title}</span>
              <span className="faint">{plan.order.counterparty?.name}{plan.order.issuedOn ? `・${plan.order.issuedOn} 決定` : ""}</span>
              <label className="field" style={{ marginLeft: "auto" }}>
                <span>作る文書</span>
                <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                  {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}{t.key === plan.templateKey ? "（この発注の既定）" : ""}</option>)}
                </select>
              </label>
            </div>
            {plan.warnings.map((w) => <div key={w} className="note">{w}</div>)}

            <p className="section-mark" style={{ margin: "6px 0 0", fontWeight: 700 }}>② 載せる実績（委託料）</p>
            <div className="tablewrap">
              <table>
                <thead><tr><th style={{ width: 32 }}></th><th>条件</th><th>実績</th><th>日付</th><th className="num">数量</th><th className="num">金額</th><th>状態</th></tr></thead>
                <tbody>
                  {plan.lines.flatMap((l) => (l.events.length ? l.events : [null]).map((e, i) => (
                    <tr key={`${l.conditionId}:${e?.id ?? "none"}`} style={e?.documentNo ? { opacity: 0.5 } : undefined}>
                      <td>{e && !e.documentNo && (
                        <input type="checkbox" checked={events.has(e.id)} aria-label={`実績 ${e.id} を載せる`}
                               onChange={() => setEvents((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} />)}</td>
                      <td>{i === 0 ? <><span className="code">{l.conditionNo ?? ""}</span> {l.name}</> : ""}</td>
                      <td>{e ? (e.label ?? "—") : <span className="faint">実績がありません（条件の画面で記録）</span>}</td>
                      <td className="code">{e?.occurredOn ?? ""}</td>
                      <td className="num">{e?.quantity ?? ""}</td>
                      <td className="num">{e ? money(e.amount, l.currency) : l.amount !== null ? <span className="faint">{money(l.amount, l.currency)}（予定）</span> : ""}</td>
                      <td>{e?.documentNo ? <span className="faint">検収済（{e.documentNo}）</span> : e ? "未検収" : ""}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>

            <p className="section-mark" style={{ margin: "6px 0 0", fontWeight: 700 }}>③ 実費・手数料（かかったかどうか）</p>
            {!extras.length && <p className="faint" style={{ margin: 0 }}>この発注書に未精算の実費・手数料はありません。かかった実費があれば足してください。</p>}
            {extras.map((x) => (
              <div key={x.key} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", borderBottom: "1px solid var(--line)", paddingBottom: 6 }}>
                <label className="field" style={{ minWidth: 180 }}>
                  <span>{x.kind === "expense" ? "実費（税込）" : "手数料（税抜）"}{x.conditionNo ? `　${x.conditionNo}` : "　追加"}</span>
                  <input value={x.name} disabled={x.conditionId !== null} onChange={(e) => setExtra(x.key, { name: e.target.value })} />
                </label>
                <label className="field">
                  <span>かかったか</span>
                  <select value={x.status} onChange={(e) => setExtra(x.key, { status: e.target.value as ExtraStatus })}>
                    <option value="incurred">かかった</option>
                    {x.conditionId !== null && <option value="skip">今回はかからなかった</option>}
                    {x.conditionId !== null && <option value="none">かからなかった（以後も発生しない）</option>}
                  </select>
                </label>
                {x.status === "incurred" && (
                  <>
                    <label className="field" style={{ minWidth: 260 }}>
                      <span>実額{x.planned ? `（見込み ${money(x.planned, currency)}）` : ""}</span>
                      <input inputMode="numeric" style={{ width: 120, textAlign: "right" }} value={x.amount} onChange={(e) => setExtra(x.key, { amount: e.target.value.replace(/[^0-9]/g, "") })} />
                    </label>
                    {x.kind === "expense" && (
                      <label className="field">
                        <span>利用日</span>
                        <input type="date" value={x.spentOn} onChange={(e) => setExtra(x.key, { spentOn: e.target.value })} />
                      </label>
                    )}
                    <label className="field" style={{ flex: 1, minWidth: 160 }}>
                      <span>備考</span>
                      <input value={x.remarks} onChange={(e) => setExtra(x.key, { remarks: e.target.value })} placeholder="区間・用途など" />
                    </label>
                  </>
                )}
                {x.conditionId === null && (
                  <button className="btn btn-sm ghost" onClick={() => setExtras((xs) => xs.filter((y) => y.key !== x.key))}>外す</button>
                )}
              </div>
            ))}
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm" onClick={() => addExtra("expense")}>＋ 実費を足す（発注書に無いもの）</button>
              <button className="btn btn-sm" onClick={() => addExtra("fee")}>＋ 手数料を足す</button>
            </div>
            <div className="faint">
              「今回はかからなかった」は今回の文書に載せないだけ（次の回で使える）。「以後も発生しない」は決定のとき完了扱いにします。
            </div>

            <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span>委託料 {money(total.main, currency)}　＋　実費・手数料 {money(total.extra, currency)}</span>
              <button className="btn primary" disabled={busy || !events.size && !plan.lines.some((l) => !l.events.length) || unanswered.length > 0}
                      onClick={create}>
                {busy ? "作成中…" : `④ ${TEMPLATES.find((t) => t.key === templateKey)?.label ?? "検収書"}の下書きを作る`}
              </button>
              {unanswered.length > 0 && <span className="warn">実額の入っていない「かかった」があります</span>}
              <span className="faint">作ったら文書の画面で中身を確かめて決定します</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
