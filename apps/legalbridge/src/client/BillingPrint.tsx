import { useEffect, useMemo, useState } from "react";

// 請求印刷（読み取り）。receipts-dashboard を作品ごとにまとめ、印刷最適化した
// 「再許諾料 受領・分配 計算書」を描画し window.print() でPDF化する。
// 社内管理用集計であり正式請求書ではない。V1 BillingPrintPage 相当。

type Row = {
  id: number;
  period: string | null;
  workCode: string | null;
  workTitle: string | null;
  counterpartyName: string | null;
  reportedSales: number | null;
  computedRoyaltyExTax: number | null;
  receivedAmount: number | null;
  computedDistributionExTax: number | null;
  received: boolean;
  distributed: boolean;
};

const yen = (v: number | null) => `¥${new Intl.NumberFormat("ja-JP").format(Math.round(v ?? 0))}`;

function today() {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function BillingPrint() {
  const [rows, setRows] = useState<Row[]>([]);
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
        const response = await fetch(`/api/v2/receipts-dashboard?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) { setRows([]); setError(response.status === 403 ? "閲覧権限がありません" : "取得に失敗しました"); return; }
        const data = await response.json();
        setRows(data.rows ?? []);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setRows([]); setError("通信に失敗しました");
      } finally { setLoading(false); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [period]);

  // 作品ごとにグループ化。
  const groups = useMemo(() => {
    const map = new Map<string, { code: string | null; title: string | null; rows: Row[] }>();
    for (const row of rows) {
      const key = `${row.workCode ?? ""}|${row.workTitle ?? row.id}`;
      if (!map.has(key)) map.set(key, { code: row.workCode, title: row.workTitle, rows: [] });
      map.get(key)!.rows.push(row);
    }
    return [...map.values()];
  }, [rows]);

  const totals = useMemo(() => ({
    royalty: rows.reduce((s, r) => s + (r.computedRoyaltyExTax ?? 0), 0),
    received: rows.reduce((s, r) => s + (r.receivedAmount ?? 0), 0),
    distribution: rows.reduce((s, r) => s + (r.computedDistributionExTax ?? 0), 0)
  }), [rows]);

  return (
    <section className="page billing-print">
      <div className="page-title print-hide">
        <div>
          <p>BILLING PRINT</p>
          <h1>請求印刷</h1>
          <small>再許諾料 受領・分配 計算書（社内管理用）</small>
        </div>
        <div className="actions">
          <input aria-label="期間" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="期間 YYYY-MM（未指定は全件）" />
          <button className="primary" onClick={() => window.print()} disabled={!rows.length}>印刷 / PDF</button>
        </div>
      </div>

      {error && <div className="async-error print-hide"><span>{error}</span></div>}

      {rows.length ? (
        <article className="print-statement">
          <header className="print-statement-head">
            <h2>再許諾料 受領・分配 計算書</h2>
            <dl>
              <div><dt>対象期間</dt><dd>{/^\d{4}-\d{2}$/.test(period) ? period : "全期間"}</dd></div>
              <div><dt>発行日</dt><dd>{today()}</dd></div>
            </dl>
          </header>

          {groups.map((group, gi) => {
            const gRoyalty = group.rows.reduce((s, r) => s + (r.computedRoyaltyExTax ?? 0), 0);
            const gDist = group.rows.reduce((s, r) => s + (r.computedDistributionExTax ?? 0), 0);
            return (
              <section className="print-group" key={gi}>
                <h3>{group.code ? `${group.code} ` : ""}{group.title ?? "（作品未設定）"}</h3>
                <table>
                  <thead><tr>
                    <th>期間</th><th>再許諾先</th><th>報告売上</th><th>受領再許諾料</th><th>実受領</th><th>ライセンサー分配</th>
                  </tr></thead>
                  <tbody>
                    {group.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.period ?? "—"}</td>
                        <td>{r.counterpartyName ?? "—"}</td>
                        <td>{yen(r.reportedSales)}</td>
                        <td>{yen(r.computedRoyaltyExTax)}</td>
                        <td>{r.received ? yen(r.receivedAmount) : "未受領"}</td>
                        <td>{r.distributed ? yen(r.computedDistributionExTax) : "未分配"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr>
                    <td colSpan={3}>小計</td>
                    <td>{yen(gRoyalty)}</td><td></td><td>{yen(gDist)}</td>
                  </tr></tfoot>
                </table>
              </section>
            );
          })}

          <section className="print-grand">
            <div><span>受領再許諾料 合計</span><strong>{yen(totals.royalty)}</strong></div>
            <div><span>実受領額 合計</span><strong>{yen(totals.received)}</strong></div>
            <div><span>ライセンサー分配 合計</span><strong>{yen(totals.distribution)}</strong></div>
          </section>

          <p className="print-note">※本計算書は社内管理用の集計であり、正式な請求書ではありません。金額は税抜です。</p>
        </article>
      ) : (
        !error && <div className="empty-state print-hide">{loading ? "読み込んでいます。" : "対象の受領記録がありません。"}</div>
      )}
    </section>
  );
}
