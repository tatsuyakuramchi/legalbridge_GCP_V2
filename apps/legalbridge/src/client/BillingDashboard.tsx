import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { ExportButtons } from "./ExportButtons";
import type { ExportColumn } from "./export-util";

// 請求ダッシュボード（読み取り）＋受領記録の登録フォーム（capability-gated）。
// V1 BillingDashboardPanel / BillingTablePanel 相当。受領登録は S6 の書込みAPI
// （POST /api/v2/condition-receipts）を使い、受領再許諾料はサーバが再計算する。

type Row = {
  id: number;
  conditionLineId: number;
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
const n0 = (v: number | null) => (v == null ? "" : Math.round(v));

const billingExportColumns: ExportColumn<Row>[] = [
  { header: "期間", value: (r) => r.period ?? "" },
  { header: "作品コード", value: (r) => r.workCode ?? "" },
  { header: "作品", value: (r) => r.workTitle ?? "" },
  { header: "相手方", value: (r) => r.counterpartyName ?? "" },
  { header: "条件名", value: (r) => r.conditionName ?? "" },
  { header: "報告売上", value: (r) => n0(r.reportedSales) },
  { header: "受領再許諾料(税抜)", value: (r) => n0(r.computedRoyaltyExTax) },
  { header: "実受領額", value: (r) => n0(r.receivedAmount) },
  { header: "ライセンサー分配(税抜)", value: (r) => n0(r.computedDistributionExTax) },
  { header: "受領", value: (r) => (r.received ? "済" : "未") },
  { header: "分配", value: (r) => (r.distributed ? "済" : "—") }
];

export function BillingDashboard({ canRecord = false, initialConditionLineId = null, onCreatePaymentDocument }: { canRecord?: boolean; initialConditionLineId?: number | null; onCreatePaymentDocument?: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("");
  const [unreceived, setUnreceived] = useState(false);
  const [undistributed, setUndistributed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [showForm, setShowForm] = useState(initialConditionLineId != null);
  // 条件明細詳細の「受領を記録」／一覧行の「この条件で記録」から条件行IDを引き継ぐ
  // （従来は別画面で見た数値IDの手入力が必須だった・監査F1/F2）。
  const [seedConditionLineId, setSeedConditionLineId] = useState<number | null>(initialConditionLineId);

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
  }, [query, period, unreceived, undistributed, reloadKey]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>BILLING</p>
          <h1>請求ダッシュボード</h1>
          <small>再許諾料の受領・分配を横断俯瞰{canRecord ? "・受領を登録できます" : "（読み取り専用）"}{loading ? "・読込中" : ""}</small>
        </div>
        <div className="matter-detail-actions">
          <ExportButtons filename="billing" sheetName="請求ダッシュボード" columns={billingExportColumns} rows={rows} />
          {onCreatePaymentDocument && <button onClick={onCreatePaymentDocument}
            title="支払通知書・請求書・計算書などの文書を作成（テンプレ一覧で「支払」「請求」で検索）">支払・請求文書を作成</button>}
          {canRecord && <button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? "閉じる" : "受領を記録"}</button>}
        </div>
      </div>

      {canRecord && showForm && (
        <ReceiptForm key={seedConditionLineId ?? "blank"} initialConditionLineId={seedConditionLineId}
          onSaved={() => { setShowForm(false); setSeedConditionLineId(null); setReloadKey((k) => k + 1); }} />
      )}

      <div className="billing-kpis">
        <article><span>受領再許諾料 合計</span><strong>{yen(summary?.totalReceiptRoyalty ?? 0)}</strong></article>
        <article><span>実受領額 合計</span><strong>{yen(summary?.totalReceived ?? 0)}</strong></article>
        <article className="warn"><span>ライセンサー分配 合計</span><strong>{yen(summary?.totalDistribution ?? 0)}</strong></article>
      </div>

      <div className="billing-toolbar">
        <input aria-label="作品・相手方で検索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="作品名・作品コード・相手方で検索" />
        <input aria-label="期間" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} title="期間で絞り込み" />
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
              <th>受領再許諾料</th><th>実受領</th><th>ライセンサー</th><th>分配</th>{canRecord && <th></th>}
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
                  {canRecord && <td><button type="button" title="この条件行で別期間の受領を記録"
                    onClick={() => { setSeedConditionLineId(r.conditionLineId); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>記録</button></td>}
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

// 受領記録の登録フォーム。受領再許諾料はサーバが再計算するため、ここでは
// 条件行・報告値・実受領などの入力のみを送る（確認トークンは自動付与）。
function ReceiptForm({ onSaved, initialConditionLineId = null }: { onSaved: () => void; initialConditionLineId?: number | null }) {
  const toast = useToast();
  const [conditionLineId, setConditionLineId] = useState(initialConditionLineId != null ? String(initialConditionLineId) : "");
  const [qtyBased, setQtyBased] = useState(false);
  const [period, setPeriod] = useState("");
  const [periodDate, setPeriodDate] = useState("");
  const [reportedSales, setReportedSales] = useState("");
  const [reportedQuantity, setReportedQuantity] = useState("");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [receivedDate, setReceivedDate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const numOrUndef = (v: string) => (v.trim() === "" ? undefined : Number(v));

  async function submit() {
    if (!/^\d+$/.test(conditionLineId)) {
      toast.push("条件行ID（数値）を入力してください", "error");
      return;
    }
    if (period && !/^\d{4}-\d{2}$/.test(period)) {
      toast.push("期間は YYYY-MM 形式で入力してください", "error");
      return;
    }
    setSaving(true);
    const body = {
      confirmation: "COMMIT_PRODUCTION_RECEIPT",
      conditionLineId: Number(conditionLineId),
      calcType: qtyBased ? "BASE_QTY_RATE" : undefined,
      period: period || undefined,
      periodDate: periodDate || undefined,
      reportedSales: qtyBased ? undefined : numOrUndef(reportedSales),
      reportedQuantity: qtyBased ? numOrUndef(reportedQuantity) : undefined,
      receivedAmount: numOrUndef(receivedAmount),
      receivedDate: receivedDate || undefined,
      note: note.trim() || undefined
    };
    try {
      const response = await fetch("/api/v2/condition-receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) {
        toast.push(result.error ?? "受領記録の保存に失敗しました", "error");
        return;
      }
      toast.push(`受領を記録しました（受領再許諾料 ¥${new Intl.NumberFormat("ja-JP").format(Math.round(result.receipt.computedRoyaltyExTax || 0))}）`, "success");
      onSaved();
    } catch {
      toast.push("通信エラーにより保存できませんでした", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="receipt-form">
      <div className="receipt-form-head">
        <strong>受領を記録</strong>
        <label className="receipt-qty-toggle"><input type="checkbox" checked={qtyBased} onChange={(e) => setQtyBased(e.target.checked)} /> 数量ベース（数量×単価×料率）</label>
      </div>
      <div className="receipt-form-grid">
        <label><span>条件行ID<em>必須</em></span><input value={conditionLineId} onChange={(e) => setConditionLineId(e.target.value)} placeholder="例：123" /></label>
        <label><span>期間</span><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <label><span>期の代表日</span><input type="date" value={periodDate} onChange={(e) => setPeriodDate(e.target.value)} /></label>
        {qtyBased
          ? <label><span>報告数量</span><input type="number" value={reportedQuantity} onChange={(e) => setReportedQuantity(e.target.value)} /></label>
          : <label><span>報告売上（税抜）</span><input type="number" value={reportedSales} onChange={(e) => setReportedSales(e.target.value)} /></label>}
        <label><span>実受領額（税抜）</span><input type="number" value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)} /></label>
        <label><span>受領日</span><input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} /></label>
        <label className="receipt-note"><span>備考</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="receipt-form-actions">
        <small>受領再許諾料は条件行の料率でサーバが再計算します。</small>
        <button className="primary" onClick={submit} disabled={saving}>{saving ? "保存中…" : "記録する"}</button>
      </div>
    </div>
  );
}
