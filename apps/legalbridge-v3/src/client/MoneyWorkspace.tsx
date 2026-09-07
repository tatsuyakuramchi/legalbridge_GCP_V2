import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

interface Balance {
  conditionId: number; conditionNo: string | null; name: string; direction: string;
  currency: string; counterparty: string | null; workTitle: string | null;
  mgAmount: number; agAmount: number; consumedTotal: number;
  agConsumed: number; agRemaining: number; agConsumptionRate: number | null;
}
interface DueCheck { verdict: "ok" | "over_limit" | "unset" | "not_applicable"; days: number | null; limitDate: string | null; overBy: number | null }
interface Payment {
  id: number; paymentNo: string | null; direction: "in" | "out";
  party: { name: string; kind: string } | null;
  currency: string; amount: number; taxAmount: number; withholdingAmount: number;
  basisReceivedOn: string | null; dueOn: string | null; paidOn: string | null; status: string;
  allocations: Array<{ conditionNo: string | null; amount: number }>;
  due: DueCheck;
}
interface Statement {
  id: number; period: string; currency: string; grossAmount: number; mgTopup: number;
  agOffset: number; netAmount: number; taxAmount: number;
  documentNo: string | null; conditionNo: string | null; conditionName: string; counterparty: string | null;
}

type Tab = "balances" | "payments" | "statements";

const DUE_LABEL: Record<DueCheck["verdict"], { text: string; tone: string }> = {
  ok: { text: "適合", tone: "ok" },
  over_limit: { text: "期日超過", tone: "out" },
  unset: { text: "期日未設定", tone: "out" },
  not_applicable: { text: "対象外", tone: "" }
};

export function MoneyWorkspace() {
  const [tab, setTab] = useState<Tab>("balances");
  const [balances, setBalances] = useState<Balance[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { void reload(); }, []);
  async function reload() {
    try {
      const [b, p, s] = await Promise.all([
        api.get<{ balances: Balance[] }>("/balances"),
        api.get<{ payments: Payment[] }>("/payments"),
        api.get<{ statements: Statement[] }>("/statements")
      ]);
      setBalances(b.balances); setPayments(p.payments); setStatements(s.statements);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  // 計算書から支払を起こす。割当が必ず付くので、根拠のない支払行が残らない。
  async function raisePayment(statementId: number) {
    setError(null); setNotice(null);
    try {
      const result = await api.post<{ paymentId: number; dueOn: string | null; due: DueCheck }>(
        `/statements/${statementId}/payment`, {});
      setNotice(result.due.verdict === "over_limit"
        ? `支払 #${result.paymentId} を作成しましたが、期日が受領日+60日を ${result.due.overBy} 日超えています`
        : `支払 #${result.paymentId} を作成しました（期日 ${result.dueOn ?? "未設定"}）`);
      setTab("payments");
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  async function markPaid(paymentId: number) {
    setError(null); setNotice(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await api.post(`/payments/${paymentId}/paid`, { paidOn: today });
      setNotice(`支払 #${paymentId} を支払済みにしました`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  const overLimit = payments.filter((p) => p.due.verdict === "over_limit").length;

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>お金</h1>
        <p>消化・支払・計算書は同じ条件の別の面。支払は必ず条件と実績に割り当てるので、根拠のない支払が残らない。</p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note">{notice}</div>}
      {overLimit > 0 && (
        <div className="alert">支払期日が受領日+60日を超えているものが {overLimit} 件あります。</div>
      )}

      <div className="tabs">
        {([["balances", `消化と残高 ${balances.length}`],
           ["payments", `支払 ${payments.length}`],
           ["statements", `計算書 ${statements.length}`]] as const).map(([key, label]) => (
          <button key={key} aria-selected={tab === key} onClick={() => setTab(key as Tab)}>{label}</button>
        ))}
      </div>

      {tab === "balances" && (
        <div className="panel">
          <div className="panel-hd"><h2>保証の消化</h2><span className="faint">AG残の大きい順</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>条件</th><th>相手先</th><th className="num">MG</th><th className="num">AG</th>
                <th className="num">AG消化</th><th style={{ width: 120 }}>進捗</th><th className="num">AG残</th>
              </tr></thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.conditionId}>
                    <td><span className="code">{b.conditionNo ?? `#${b.conditionId}`}</span>
                        <div className="faint">{b.name}</div></td>
                    <td>{b.counterparty ?? "—"}</td>
                    <td className="num">{money(b.mgAmount, b.currency)}</td>
                    <td className="num">{money(b.agAmount, b.currency)}</td>
                    <td className="num">{money(b.agConsumed, b.currency)}</td>
                    <td>
                      <div className="meter">
                        <i style={{ width: `${Math.round((b.agConsumptionRate ?? 0) * 100)}%` }} />
                      </div>
                    </td>
                    <td className="num">{money(b.agRemaining, b.currency)}</td>
                  </tr>
                ))}
                {!balances.length && <tr><td colSpan={7} className="faint">保証のある条件がありません</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="panel-bd" style={{ paddingTop: 10 }}>
            <div className="faint">MGは毎期独立の下限なので消化されません。ここに出るのはAGの消化だけです。</div>
          </div>
        </div>
      )}

      {tab === "payments" && (
        <div className="panel">
          <div className="panel-hd"><h2>支払</h2><span className="faint">期日順</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>向き</th><th>相手先</th><th className="num">税抜</th><th className="num">源泉</th>
                <th>受領日</th><th>期日</th><th>期日の検査</th><th>割当</th><th>状態</th><th></th>
              </tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.direction === "in" ? "入金" : "支払"}</td>
                    <td>{p.party?.name ?? "—"}
                        {p.party?.kind === "individual" && <span className="tag" style={{ marginLeft: 5 }}>個人</span>}</td>
                    <td className="num">{money(p.amount, p.currency)}</td>
                    <td className="num">{p.withholdingAmount ? money(p.withholdingAmount, p.currency) : "—"}</td>
                    <td className="code">{p.basisReceivedOn ?? "—"}</td>
                    <td className="code">{p.dueOn ?? "—"}</td>
                    <td>
                      <span className={`tag ${DUE_LABEL[p.due.verdict].tone}`}>{DUE_LABEL[p.due.verdict].text}</span>
                      {p.due.overBy && <span className="faint"> +{p.due.overBy}日</span>}
                    </td>
                    <td className="faint">{p.allocations.map((a) => a.conditionNo ?? "—").join("、") || "なし"}</td>
                    <td><span className="tag">{p.status}</span></td>
                    <td>{p.status !== "paid" && (
                      <button className="btn btn-sm" onClick={() => markPaid(p.id)}>支払済みにする</button>
                    )}</td>
                  </tr>
                ))}
                {!payments.length && <tr><td colSpan={10} className="faint">支払がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "statements" && (
        <div className="panel">
          <div className="panel-hd"><h2>計算書</h2></div>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>文書番号</th><th>期間</th><th>条件 / 相手先</th>
                <th className="num">グロス</th><th className="num">MG上乗せ</th><th className="num">AG相殺</th>
                <th className="num">正味</th><th></th>
              </tr></thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id}>
                    <td className="code">{s.documentNo ?? "—"}</td>
                    <td>{s.period}</td>
                    <td><span className="code">{s.conditionNo ?? "—"}</span>
                        <div className="faint">{s.counterparty ?? s.conditionName}</div></td>
                    <td className="num">{money(s.grossAmount, s.currency)}</td>
                    <td className="num">{s.mgTopup ? money(s.mgTopup, s.currency) : "—"}</td>
                    <td className="num">{s.agOffset ? `▲${money(s.agOffset, s.currency)}` : "—"}</td>
                    <td className="num"><b>{money(s.netAmount, s.currency)}</b></td>
                    <td><button className="btn btn-sm" onClick={() => raisePayment(s.id)}>支払を起こす</button></td>
                  </tr>
                ))}
                {!statements.length && <tr><td colSpan={8} className="faint">計算書がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
