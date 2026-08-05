import { useEffect, useState } from "react";

// 支払報告書（読み取り）。出金台帳に源泉徴収・消費税を適用し、差引振込額まで表示。
// CSV出力はクライアント側で生成（外部依存なし）。V1 支払Excel出力の内容に相当。

type Line = {
  paymentId: number;
  vendorName: string;
  vendorCode: string;
  invoiceRegistrationNumber: string;
  period: string;
  currency: string;
  withholdingEnabled: boolean;
  subtotalExTax: number;
  consumptionTax: number;
  taxIncluded: number;
  withholdingTax: number;
  netTransfer: number;
};
type Totals = { subtotalExTax: number; consumptionTax: number; withholdingTax: number; netTransfer: number; count: number };

const yen = (v: number) => new Intl.NumberFormat("ja-JP").format(Math.round(v || 0));

function toCsv(lines: Line[]): string {
  const header = ["支払ID", "取引先コード", "取引先", "インボイス番号", "期間", "通貨", "源泉対象", "税抜", "消費税", "税込", "源泉税", "差引振込額"];
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = lines.map((l) => [
    l.paymentId, l.vendorCode, l.vendorName, l.invoiceRegistrationNumber, l.period, l.currency,
    l.withholdingEnabled ? "対象" : "対象外", l.subtotalExTax, l.consumptionTax, l.taxIncluded, l.withholdingTax, l.netTransfer
  ].map(escape).join(","));
  return [header.join(","), ...rows].join("\r\n");
}

export function PaymentReport() {
  const [lines, setLines] = useState<Line[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [period, setPeriod] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      const params = new URLSearchParams();
      if (/^\d{4}-\d{2}$/.test(period)) params.set("period", period);
      try {
        const response = await fetch(`/api/v2/payment-report?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) { setLines([]); setTotals(null); setError(response.status === 403 ? "閲覧権限がありません" : "取得に失敗しました"); return; }
        const data = await response.json();
        setLines(data.lines ?? []); setTotals(data.totals ?? null);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setLines([]); setTotals(null); setError("通信に失敗しました");
      } finally { setLoading(false); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [period]);

  function downloadCsv() {
    const blob = new Blob(["﻿" + toCsv(lines)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payment-report${period ? `-${period}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>PAYMENT REPORT</p>
          <h1>支払報告書</h1>
          <small>出金台帳に源泉徴収・消費税を適用（読み取り専用）{loading ? "・読込中" : ""}</small>
        </div>
        <button className="primary" onClick={downloadCsv} disabled={!lines.length}>CSV出力</button>
      </div>

      <div className="billing-toolbar">
        <input aria-label="期間" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="期間 YYYY-MM（未指定は全件）" />
        <span>{totals?.count ?? 0}件</span>
      </div>

      {totals && (
        <div className="billing-kpis four">
          <article><span>税抜 合計</span><strong>¥{yen(totals.subtotalExTax)}</strong></article>
          <article><span>消費税 合計</span><strong>¥{yen(totals.consumptionTax)}</strong></article>
          <article className="warn"><span>源泉税 合計</span><strong>¥{yen(totals.withholdingTax)}</strong></article>
          <article><span>差引振込額 合計</span><strong>¥{yen(totals.netTransfer)}</strong></article>
        </div>
      )}

      {error && <div className="async-error"><span>{error}</span></div>}

      {lines.length ? (
        <div className="billing-table-wrap">
          <table className="billing-table">
            <thead><tr>
              <th>取引先</th><th>期間</th><th>源泉</th><th>税抜</th><th>消費税</th><th>税込</th><th>源泉税</th><th>差引振込額</th>
            </tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.paymentId}>
                  <td>{l.vendorCode ? <small>{l.vendorCode} </small> : ""}{l.vendorName}</td>
                  <td>{l.period || "—"}</td>
                  <td>{l.withholdingEnabled ? <span className="billing-unlinked">対象</span> : "—"}</td>
                  <td>¥{yen(l.subtotalExTax)}</td>
                  <td>¥{yen(l.consumptionTax)}</td>
                  <td>¥{yen(l.taxIncluded)}</td>
                  <td className={l.withholdingTax ? "billing-pending" : ""}>{l.withholdingTax ? `−¥${yen(l.withholdingTax)}` : "—"}</td>
                  <td><strong>¥{yen(l.netTransfer)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !error && <div className="empty-state">{loading ? "読み込んでいます。" : "対象の支払がありません（出金台帳が空、または権限未付与）。"}</div>
      )}
    </section>
  );
}
