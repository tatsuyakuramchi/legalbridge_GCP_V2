import { useEffect, useState } from "react";
import { ListCount, ListSearch, useDebounced } from "./ListTools.js";
import { PaymentAllocation, type AllocationTarget } from "./PaymentAllocation.js";
import { StatusTag } from "./labels.js";
import { api, ApiError, money } from "./api.js";
import { CreateForm, int, text } from "./CreateForm.js";
import { PaymentReport } from "./PaymentReport.js";

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

type Tab = "balances" | "payments" | "statements" | "report";

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
  const [creating, setCreating] = useState(false);
  const [parties, setParties] = useState<Array<{ id: number; name: string; kind: string }>>([]);
  const [keyword, setKeyword] = useState("");
  const [dirFilter, setDirFilter] = useState<"all" | "in" | "out">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "unallocated" | "unpaid">("all");
  const [allocating, setAllocating] = useState<AllocationTarget | null>(null);
  const search = useDebounced(keyword);

  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (!creating || parties.length) return;
    api.get<{ parties: Array<{ id: number; name: string; kind: string }> }>("/parties")
      .then((r) => setParties(r.parties)).catch(() => undefined);
  }, [creating]);
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

  const unallocatedCount = payments.filter((p) => !p.allocations.length).length;
  const needle = search.trim().toLowerCase();
  const shownPayments = payments.filter((p) => {
    if (dirFilter !== "all" && p.direction !== dirFilter) return false;
    if (statusFilter === "unallocated" && p.allocations.length) return false;
    if (statusFilter === "unpaid" && p.status === "paid") return false;
    if (!needle) return true;
    // 相手先・支払番号・割当先の条件番号のどれかに当たれば残す。
    return [p.party?.name, p.paymentNo, ...p.allocations.map((a) => a.conditionNo)]
      .some((v) => String(v ?? "").toLowerCase().includes(needle));
  });

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>お金</h1>
        <p>消化・支払・計算書は同じ条件の別の面。支払は必ず条件と実績に割り当てるので、根拠のない支払が残らない。</p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}
      {overLimit > 0 && (
        <div className="alert">支払期日が受領日+60日を超えているものが {overLimit} 件あります。</div>
      )}

      <div className="row" style={{ marginBottom: 10 }}>
        {!creating && <button className="btn primary btn-sm" onClick={() => setCreating(true)}>支払を起こす</button>}
      </div>

      {creating && (
        <CreateForm
          title="支払の登録"
          submitLabel="支払を起こす"
          path="/payments"
          initial={{ direction: "out", currency: "JPY" }}
          fields={[
            { name: "partyId", label: "相手先", type: "select", required: true,
              options: parties.map((p) => ({
                value: String(p.id),
                label: `${p.name}${p.kind === "individual" ? "（個人）" : ""}`
              })) },
            { name: "direction", label: "向き", type: "select", required: true,
              options: [{ value: "out", label: "支払う" }, { value: "in", label: "受け取る" }] },
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
            partyId: int(v.partyId), direction: v.direction, amount: int(v.amount) ?? 0,
            taxAmount: int(v.taxAmount), withholdingAmount: int(v.withholdingAmount),
            currency: v.currency || "JPY",
            basisReceivedOn: text(v.basisReceivedOn), dueOn: text(v.dueOn), note: text(v.note)
          })}
          onDone={(r) => {
            setCreating(false);
            setNotice(`${r.paymentNo} を起こしました`);
            void reload();
          }}
          onCancel={() => setCreating(false)}
        >
          <p className="faint">
            相手先が個人（特定受託事業者）なら、受領日から60日を超える期日では登録できない。
            法人相手は検査の対象外だが、期日と受領日は記録に残る。
          </p>
        </CreateForm>
      )}

      <div className="tabs">
        {([["balances", `消化と残高 ${balances.length}`],
           ["payments", `支払 ${payments.length}`],
           ["statements", `計算書 ${statements.length}`],
           ["report", "支払報告書"]] as const).map(([key, label]) => (
          <button key={key} aria-selected={tab === key} onClick={() => setTab(key as Tab)}>{label}</button>
        ))}
      </div>

      {tab === "report" && <PaymentReport />}

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
        <div className="stack">
        {allocating && (
          <PaymentAllocation payment={allocating}
            onClose={() => setAllocating(null)}
            onSaved={() => { setAllocating(null); setNotice("割当を保存しました。"); void reload(); }} />
        )}
        <div className="panel">
          <div className="panel-hd">
            <h2>支払</h2><span className="faint">期日順</span>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="相手先・支払番号・条件番号" label="支払を絞り込む" />
          </div>
          <ListCount shown={shownPayments.length} keyword={search} total={payments.length}
                     onClear={() => { setKeyword(""); setDirFilter("all"); setStatusFilter("all"); }}>
            <span className="filters">
              {(["all", "out", "in"] as const).map((v) => (
                <button key={v} className="chip" aria-pressed={dirFilter === v}
                        onClick={() => setDirFilter(v)}>
                  {v === "all" ? "すべて" : v === "out" ? "支払" : "入金"}
                </button>
              ))}
              <button className="chip" aria-pressed={statusFilter === "unallocated"}
                      onClick={() => setStatusFilter(statusFilter === "unallocated" ? "all" : "unallocated")}>
                割当なし {unallocatedCount}
              </button>
              <button className="chip" aria-pressed={statusFilter === "unpaid"}
                      onClick={() => setStatusFilter(statusFilter === "unpaid" ? "all" : "unpaid")}>
                未払い
              </button>
            </span>
          </ListCount>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>支払番号</th><th>向き</th><th>相手先</th><th className="num">税抜</th><th className="num">源泉</th>
                <th>受領日</th><th>期日</th><th>期日の検査</th><th>割当</th><th>状態</th><th></th>
              </tr></thead>
              <tbody>
                {shownPayments.map((p) => (
                  <tr key={p.id}>
                    <td className="code">{p.paymentNo ?? `#${p.id}`}</td>
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
                    <td>
                      {p.allocations.length
                        ? <span className="faint">{p.allocations.map((a) => a.conditionNo ?? "—").join("、")}</span>
                        : <span className="tag warn">割当なし</span>}
                    </td>
                    <td><StatusTag kind="payment" value={p.status} /></td>
                    <td className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <button className="btn btn-sm" onClick={() => setAllocating({
                        id: p.id, paymentNo: p.paymentNo, currency: p.currency, amount: p.amount,
                        partyName: p.party?.name ?? "—", dueOn: p.dueOn, allocations: p.allocations
                      })}>割当</button>
                      {p.status !== "paid" && (
                        <button className="btn btn-sm" onClick={() => markPaid(p.id)}>支払済みに</button>
                      )}
                    </td>
                  </tr>
                ))}
                {!shownPayments.length && (
                  <tr><td colSpan={11} className="faint">
                    {payments.length ? "この絞り込みに一致する支払はありません" : "支払がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
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
