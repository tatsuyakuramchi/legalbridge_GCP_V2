import { useState } from "react";
import { api, ApiError, money } from "./api.js";

interface Line {
  paymentNo: string | null; conditions: string | null;
  amount: number; taxAmount: number; withholdingAmount: number; netAmount: number;
  dueOn: string | null; paidOn: string | null; status: string; note: string | null;
}
interface Group {
  partyId: number; partyName: string; partyKind: "corporate" | "individual";
  invoiceNo: string | null; currency: string; lines: Line[];
  total: { amount: number; taxAmount: number; withholdingAmount: number; netAmount: number };
}
interface CurrencyTotal {
  currency: string; amount: number; taxAmount: number;
  withholdingAmount: number; netAmount: number; count: number;
}
interface Report {
  from: string; to: string; basis: "due" | "paid"; groups: Group[];
  totals: CurrencyTotal[]; count: number;
}

/** 当月の初日と末日。既定の期間に使う。 */
function thisMonth(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${y}-${pad(m + 1)}-01`,
    to: `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`
  };
}

/**
 * 支払報告書。相手先ごとに期間内の支払を明細と合計で出す。
 * 印刷はブラウザに任せる（PDF 化も印刷ダイアログから行う）。
 */
export function PaymentReport() {
  const [range, setRange] = useState(thisMonth());
  const [basis, setBasis] = useState<"paid" | "due">("paid");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setError(null);
    try {
      setReport(await api.get<Report>(
        `/reports/payments?from=${range.from}&to=${range.to}&basis=${basis}`));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>支払報告書</h2>
        <span className="faint">相手先ごと・期間内の支払</span>
      </div>
      <div className="panel-bd">
        <div className="row no-print" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label className="field">
            <span>開始</span>
            <input type="date" value={range.from}
                   onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="field">
            <span>終了</span>
            <input type="date" value={range.to}
                   onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </label>
          <label className="field">
            <span>期間の基準</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value as "paid" | "due")}>
              <option value="paid">支払日（経理の月次）</option>
              <option value="due">期日（これから払う分）</option>
            </select>
          </label>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? "集計中…" : "集計する"}
          </button>
          {report && (
            <button className="btn" onClick={() => window.print()}>印刷 / PDF</button>
          )}
        </div>

        {error && <div className="alert">{error}</div>}

        {report && (
          <div className="report">
            <div className="report-head">
              <h3>支払報告書</h3>
              <div className="faint">
                {report.from} 〜 {report.to}（{report.basis === "paid" ? "支払日" : "期日"}基準）
                ／ {report.count} 件
              </div>
            </div>

            {!report.groups.length && (
              <p className="faint">この期間に支払はありません。</p>
            )}

            {report.groups.map((g) => (
              <div key={g.partyId} className="report-group">
                <div className="report-group-hd">
                  <b>{g.partyName}</b>
                  <span className="faint">
                    {g.partyKind === "individual" ? "個人" : "法人"}
                    {g.invoiceNo ? ` ／ ${g.invoiceNo}` : ""}
                  </span>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>支払番号</th><th>対象条件</th><th>期日</th><th>支払日</th>
                        <th className="num">税抜</th><th className="num">消費税</th>
                        <th className="num">源泉</th><th className="num">差引</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.lines.map((l, i) => (
                        <tr key={`${l.paymentNo}-${i}`}>
                          <td className="code">{l.paymentNo ?? "—"}</td>
                          <td className="code">{l.conditions ?? "—"}</td>
                          <td className="code">{l.dueOn ?? "—"}</td>
                          <td className="code">{l.paidOn ?? "—"}</td>
                          <td className="num">{money(l.amount, g.currency)}</td>
                          <td className="num">{money(l.taxAmount, g.currency)}</td>
                          <td className="num">{money(l.withholdingAmount, g.currency)}</td>
                          <td className="num">{money(l.netAmount, g.currency)}</td>
                        </tr>
                      ))}
                      <tr className="report-total">
                        <td colSpan={4}>小計（{g.lines.length} 件）</td>
                        <td className="num">{money(g.total.amount, g.currency)}</td>
                        <td className="num">{money(g.total.taxAmount, g.currency)}</td>
                        <td className="num">{money(g.total.withholdingAmount, g.currency)}</td>
                        <td className="num">{money(g.total.netAmount, g.currency)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {report.groups.length > 1 && (
              <div className="report-group">
                <div className="report-group-hd"><b>総計</b>
                  <span className="faint">通貨ごと</span></div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr><th>通貨</th><th className="num">件数</th><th className="num">税抜</th>
                          <th className="num">消費税</th><th className="num">源泉</th>
                          <th className="num">差引</th></tr>
                    </thead>
                    <tbody>
                      {report.totals.map((t) => (
                        <tr key={t.currency} className="report-total">
                          <td>{t.currency}</td>
                          <td className="num">{t.count}</td>
                          <td className="num">{money(t.amount, t.currency)}</td>
                          <td className="num">{money(t.taxAmount, t.currency)}</td>
                          <td className="num">{money(t.withholdingAmount, t.currency)}</td>
                          <td className="num">{money(t.netAmount, t.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
