import { useEffect, useState } from "react";

// 請求ダッシュボード（読み取り）。再許諾料の受領・分配を横断俯瞰し、3KPIを表示。
// V1 BillingDashboardPanel 相当。書込みは行わない。

type Row = {
  id: number;
  period: string | null;
  workCode: string | null;
  workTitle: string | null;
  counterpartyName: string | null;
  conditionName: string | null;
  reportedSales: number | null;
  computedRoyaltyExTax: number | null;
  receivedAmount: number | null;
  computedDistributionExTax: number | null;
  hasParentLicense: boolean;
  received: boolean;
  distributed: boolean;
};
type Summary = {
  totalReceiptRoyalty: number;
  totalReceived: number;
  totalDistribution: number;
  count: number;
  truncated: boolean;
};

const yen = (value: number | null) => `¥${new Intl.NumberFormat("ja-JP").format(Math.round(value ?? 0))}`;

export function BillingDashboard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("");
  const [unreceived, setUnreceived] = useState(false);
  const [undistributed, setUndistributed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (/^\d{4}-\d{2}$/.test(period)) params.set("period", period);
      if (unreceived) params.set("unreceived", "true");
      if (undistributed) params.set("undistributed", "true");
      try {
        const response = await fetch(`/api/v2/receipts-dashboard?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) {
          setRows([]); setSummary(null);
          setError(response.status === 403 ? "閲覧権限がありません" : "取得に失敗しました");
          return;
        }
        const data = await response.json();
        setRows(data.rows ?? []);
        setSummary(data.summary ?? null);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setRows([]); setSummary(null);
        setError("通信に失敗しました");
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, period, unreceived, undistributed]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>BILLING</p>
          <h1>請求ダッシュボード</h1>
          <small>再許諾料の受領・分配を横断俯瞰（読み取り専用）{loading ? "・読込中" : ""}</small>
        </div>
      </div>

      <div className="billing-kpis">
        <article><span>受領再許諾料 合計</span><strong>{yen(summary?.totalReceiptRoyalty ?? 0)}</strong></article>
        <article><span>実受領額 合計</span><strong>{yen(summary?.totalReceived ?? 0)}</strong></article>
        <article className="warn"><span>ライセンサー分配 合計</span><strong>{yen(summary?.totalDistribution ?? 0)}</strong></article>
      </div>

      <div className="billing-toolbar">
        <input aria-label="作品・相手方で検索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="作品名・作品コード・相手方で検索" />
        <input aria-label="期間" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="期間 YYYY-MM" />
        <button className={unreceived ? "active" : ""} onClick={() => setUnreceived((v) => !v)}>未受領のみ</button>
        <button className={undistributed ? "active" : ""} onClick={() => setUndistributed((v) => !v)}>未分配のみ</button>
        <span>{summary?.count ?? 0}件{summary?.truncated ? "（上限）" : ""}</span>
      </div>

      {error && <div className="async-error"><span>{error}</span></div>}

      {rows.length ? (
        <div className="billing-table-wrap">
          <table className="billing-table">
            <thead><tr>
              <th>期間</th><th>作品</th><th>再許諾先</th><th>報告売上</th>
              <th>受領再許諾料</th><th>実受領</th><th>ライセンサー</th><th>分配</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.period ?? "—"}</td>
                  <td>{r.workCode ? <small>{r.workCode} </small> : ""}{r.workTitle ?? "—"}</td>
                  <td>{r.counterpartyName ?? "—"}</td>
                  <td>{yen(r.reportedSales)}</td>
                  <td>{yen(r.computedRoyaltyExTax)}</td>
                  <td className={r.received ? "" : "billing-pending"}>{r.received ? yen(r.receivedAmount) : "未受領"}</td>
                  <td>{r.hasParentLicense ? "" : <span className="billing-unlinked">未リンク</span>}</td>
                  <td className={r.distributed ? "" : "billing-pending"}>{r.distributed ? yen(r.computedDistributionExTax) : "未分配"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !error && <div className="empty-state">{loading ? "読み込んでいます。" : "該当する受領記録がありません。"}</div>
      )}
    </section>
  );
}
