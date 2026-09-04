import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { FeatureLockedNote } from "./FeatureLockedNote";
import { exportExcel, type ExportColumn } from "./export-util";

// Excel 一括出力（Phase 10-5）。検収書・利用許諾料計算書を「種別×担当者×支払期日」で束ねて表示し、
// グループ単位で Excel（client 生成・依存ゼロ）を出力。任意で「発行済み」にして保留から外す。

// 税区分内訳（経理提出用・2026-09-04）。サーバ（document-tax-breakdown）が文書ごとに算出。
type TaxCols = { taxable10: number; reduced8: number; exempt: number; legacyIncTax: number; tax: number; totalIncTax: number };
// 経理提出用エクセル（V1 互換の 8 スロットレイアウト）。サーバ（accounting-row）が文書ごとに組む。
type Slot = { content: string; unitPrice: number | ""; quantity: number | ""; amount: number | ""; deliveryDate: string };
type Accounting = {
  title: string; paymentDate: string; department: string; vendorCode: string; vendorName: string; vendorNameKana: string;
  slots: Slot[]; reimbursement: number; subtotal: number; consumptionTax: number; withholdingTax: number;
  afterTax: number; netTransfer: number; withholdingEnabled: boolean; invoiceRegistration: string;
};
type BatchItem = TaxCols & { documentNumber: string; inspectionDate: string; title: string; counterparty: string; accounting?: Accounting };
type BatchGroup = {
  key: string;
  category: "inspection_certificate" | "royalty_statement";
  inspectorEmail: string;
  inspectorName: string;
  paymentDate: string;
  count: number;
  documentNumbers: string[];
  items: BatchItem[];
  totals?: TaxCols;
};

const CATEGORY_LABEL: Record<BatchGroup["category"], string> = {
  inspection_certificate: "検収書",
  royalty_statement: "利用許諾料計算書"
};

const money = (v: number | undefined) => Math.round(v || 0);
const yen = (v: number | undefined) => `¥${money(v).toLocaleString("ja-JP")}`;

// 出力列。合計行は documentNumber="合計" で末尾に付ける（CSV/Excel 共通）。
const itemColumns: ExportColumn<BatchItem>[] = [
  { header: "文書番号", value: (r) => r.documentNumber },
  { header: "検収日/発行日", value: (r) => r.inspectionDate },
  { header: "件名", value: (r) => r.title },
  { header: "取引先", value: (r) => r.counterparty },
  { header: "課税対象（10%）税抜", value: (r) => money(r.taxable10) },
  { header: "課税対象（8%）税抜", value: (r) => money(r.reduced8) },
  { header: "非課税・不課税", value: (r) => money(r.exempt) },
  { header: "経費（税込・区分未設定）", value: (r) => money(r.legacyIncTax) },
  { header: "消費税", value: (r) => money(r.tax) },
  { header: "税込合計", value: (r) => money(r.totalIncTax) }
];

function withTotals(g: BatchGroup): BatchItem[] {
  const t = g.totals;
  if (!t) return g.items;
  return [...g.items, { documentNumber: "合計", inspectionDate: "", title: `${g.count}件`, counterparty: "", ...t }];
}

// 経理提出用（V1 互換）: 件名／支払日／部署／取引先コード／氏名／氏名（カナ）／支払内容・単価・数量・金額・納品日×8／
// 立替金／小計／消費税／源泉税／税引後／差引振込額／インボイス登録。末尾に V2 の税区分内訳と文書番号を足す。
const a = (r: BatchItem) => r.accounting;
const slot = (r: BatchItem, i: number): Slot => a(r)?.slots?.[i] ?? { content: "", unitPrice: "", quantity: "", amount: "", deliveryDate: "" };
const accountingColumns: ExportColumn<BatchItem>[] = [
  { header: "件名", value: (r) => a(r)?.title ?? r.title },
  { header: "支払日", value: (r) => a(r)?.paymentDate ?? "" },
  { header: "部署", value: (r) => a(r)?.department ?? "" },
  { header: "取引先コード", value: (r) => a(r)?.vendorCode ?? "" },
  { header: "氏名", value: (r) => a(r)?.vendorName ?? r.counterparty },
  { header: "氏名（カナ）", value: (r) => a(r)?.vendorNameKana ?? "" },
  ...Array.from({ length: 8 }, (_, i) => [
    { header: `支払内容（${i + 1}）`, value: (r: BatchItem) => slot(r, i).content },
    { header: `単価（${i + 1}）`, value: (r: BatchItem) => slot(r, i).unitPrice },
    { header: `数量（${i + 1}）`, value: (r: BatchItem) => slot(r, i).quantity },
    { header: `金額（${i + 1}）`, value: (r: BatchItem) => slot(r, i).amount },
    { header: `納品日(${i + 1})`, value: (r: BatchItem) => slot(r, i).deliveryDate }
  ]).flat(),
  { header: "立替金", value: (r) => money(a(r)?.reimbursement) },
  { header: "小計", value: (r) => money(a(r)?.subtotal) },
  { header: "消費税", value: (r) => money(a(r)?.consumptionTax) },
  { header: "源泉税", value: (r) => money(a(r)?.withholdingTax) },
  { header: "税引後", value: (r) => money(a(r)?.afterTax) },
  { header: "差引振込額", value: (r) => money(a(r)?.netTransfer) },
  { header: "インボイス登録", value: (r) => a(r)?.invoiceRegistration ?? "" },
  { header: "課税対象（10%）税抜", value: (r) => money(r.taxable10) },
  { header: "課税対象（8%）税抜", value: (r) => money(r.reduced8) },
  { header: "非課税・不課税", value: (r) => money(r.exempt) },
  { header: "文書番号", value: (r) => r.documentNumber }
];

export function ExcelBatchWorkspace({ canMark = false }: { canMark?: boolean }) {
  const [groups, setGroups] = useState<BatchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busyKey, setBusyKey] = useState("");
  const toast = useToast();

  useEffect(() => {
    setLoading(true); setError("");
    fetch("/api/v2/documents/excel-batches")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setGroups(d.groups ?? []))
      .catch(() => setError("集計を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, [reload]);

  // 経理提出用（V1 互換の 8 スロット・源泉列）。1 文書 = 1 行。
  function downloadGroup(g: BatchGroup) {
    const date = g.paymentDate || "no-date";
    const name = `${CATEGORY_LABEL[g.category]}_${g.inspectorName}_${date}`.replace(/[^\w.\-一-龥ぁ-んァ-ン]/g, "_");
    exportExcel(name, CATEGORY_LABEL[g.category], accountingColumns, g.items);
  }
  // 内訳一覧（文書番号・税区分内訳・合計行）。
  function downloadBreakdown(g: BatchGroup) {
    const date = g.paymentDate || "no-date";
    const name = `${CATEGORY_LABEL[g.category]}_内訳_${g.inspectorName}_${date}`.replace(/[^\w.\-一-龥ぁ-んァ-ン]/g, "_");
    exportExcel(name, CATEGORY_LABEL[g.category], itemColumns, withTotals(g));
  }

  async function markGroup(g: BatchGroup) {
    setBusyKey(g.key);
    try {
      const response = await fetch("/api/v2/documents/excel-batches/mark", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentNumbers: g.documentNumbers, batchKey: g.key })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "発行済み記録に失敗しました。", "error"); return; }
      toast.push(`${data.recorded}件を発行済みにしました。`, "success");
      setReload((v) => v + 1);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusyKey(""); }
  }

  return <section className="page">
    <div className="page-title">
      <div><p>EXCEL BATCH</p><h1>Excel一括出力</h1>
        <small>未出力の検収書・利用許諾料計算書を担当者×支払期日でまとめてExcel化します。「経理提出用Excel」は旧システムと同じ列並び（支払内容×8・立替金・小計・消費税・源泉税・税引後・差引振込額・インボイス登録）で、金額は V2 の計算書・検収書から出ます</small></div>
      <button onClick={() => setReload((v) => v + 1)}>再読込</button>
    </div>
    {!canMark && <FeatureLockedNote>「発行済みにする」の記録は未有効化です。Excel出力（ダウンロード）は利用できます。</FeatureLockedNote>}
    {error && <div className="async-error">{error}<button onClick={() => setReload((v) => v + 1)}>再試行</button></div>}
    {loading && <p className="hub-note">集計中…</p>}
    {!loading && !groups.length && <EmptyState icon="▤" title="未出力の対象がありません"
      description="確定済みの検収書・利用許諾料計算書がすべて出力済みか、対象がありません。" />}
    <div className="batch-groups">
      {groups.map((g) => <div key={g.key} className="panel batch-group">
        <div className="batch-group-head">
          <div>
            <span className="registry-state neutral">{CATEGORY_LABEL[g.category]}</span>
            <strong> {g.inspectorName}</strong>
            <span className="muted"> ｜支払期日 {g.paymentDate || "未設定"} ｜{g.count}件</span>
            {g.totals && <span className="muted"> ｜課税10% {yen(g.totals.taxable10)}
              {g.totals.reduced8 ? ` ｜課税8% ${yen(g.totals.reduced8)}` : ""}
              {g.totals.exempt ? ` ｜非課税 ${yen(g.totals.exempt)}` : ""}
              {g.totals.legacyIncTax ? ` ｜経費（区分未設定）${yen(g.totals.legacyIncTax)}` : ""}
              ｜消費税 {yen(g.totals.tax)} ｜税込 <b>{yen(g.totals.totalIncTax)}</b></span>}
          </div>
          <div className="batch-group-actions">
            <button className="primary" onClick={() => downloadGroup(g)} title="経理提出用（支払スロット×8・立替金・小計・消費税・源泉税・税引後・差引振込額・インボイス登録）">経理提出用Excel（{g.count}件）</button>
            <button onClick={() => downloadBreakdown(g)} title="文書番号・税区分内訳・合計行の一覧">内訳一覧</button>
            {canMark && <button disabled={busyKey === g.key} onClick={() => void markGroup(g)}>
              {busyKey === g.key ? "記録中…" : "発行済みにする"}
            </button>}
          </div>
        </div>
        <div className="condition-table-wrap"><table className="condition-table">
          <thead><tr><th>文書番号</th><th>検収日/発行日</th><th>件名</th><th>取引先</th>
            <th className="right">課税10%</th><th className="right">課税8%</th><th className="right">非課税</th><th className="right">消費税</th><th className="right">税込</th></tr></thead>
          <tbody>{g.items.slice(0, 50).map((it) => <tr key={it.documentNumber}>
            <td><b>{it.documentNumber}</b></td><td>{it.inspectionDate || "—"}</td>
            <td>{it.title || "—"}</td><td>{it.counterparty || "—"}</td>
            <td className="right">{yen(it.taxable10)}</td><td className="right">{it.reduced8 ? yen(it.reduced8) : "—"}</td>
            <td className="right">{it.exempt ? yen(it.exempt) : "—"}{it.legacyIncTax ? <small title="税区分の無い旧データの経費（税込）">＋経費 {yen(it.legacyIncTax)}</small> : null}</td>
            <td className="right">{yen(it.tax)}</td><td className="right"><b>{yen(it.totalIncTax)}</b></td>
          </tr>)}</tbody>
        </table>{g.items.length > 50 && <p className="import-preview-note">ほか {g.items.length - 50}件…</p>}</div>
      </div>)}
    </div>
  </section>;
}
