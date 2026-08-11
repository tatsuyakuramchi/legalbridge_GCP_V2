import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import { useToast } from "./Toast";
import { ExportButtons } from "./ExportButtons";
import type { ExportColumn } from "./export-util";

const conditionExportColumns: ExportColumn<ConditionLine>[] = [
  { header: "条件名", value: (c) => c.conditionName },
  { header: "向き", value: (c) => (c.direction === "receivable" ? "受取" : c.direction === "payable" ? "支払" : "") },
  { header: "相手方", value: (c) => c.vendorName },
  { header: "作品", value: (c) => c.workTitle },
  { header: "地域", value: (c) => c.territory ?? "" },
  { header: "通貨", value: (c) => c.currency ?? "" },
  { header: "税抜金額", value: (c) => (c.amountExTax == null ? "" : Math.round(c.amountExTax)) },
  { header: "MG", value: (c) => (c.mgAmount == null ? "" : Math.round(c.mgAmount)) },
  { header: "料率%", value: (c) => (c.ratePct == null ? "" : c.ratePct) },
  { header: "文書番号", value: (c) => c.documentNumber ?? "" },
  { header: "開始", value: (c) => c.termStart ?? "" }
];
const inspectionExportColumns: ExportColumn<PendingInspection>[] = [
  { header: "文書番号", value: (i) => i.documentNumber ?? "" },
  { header: "受付番号", value: (i) => i.issueKey ?? "" },
  { header: "案件コード", value: (i) => i.matterCode ?? "" },
  { header: "案件名", value: (i) => i.matterTitle ?? "" },
  { header: "作成日時", value: (i) => i.createdAt ?? "" },
  { header: "検収", value: (i) => (i.hasInspection ? "済" : "未") }
];

type ConditionLine = {
  id: number; lineNo: number | null; documentId: number | null; documentNumber: string | null;
  matterId: number | null; templateType: string | null; direction: string | null;
  flowDirection: string | null; transactionKind: string | null; conditionName: string;
  vendorName: string; workTitle: string; territory: string | null; currency: string | null;
  amountExTax: number | null; mgAmount: number | null; ratePct: number | null; termStart: string | null;
};
type SummaryRow = { direction: string; currency: string; lineCount: number; totalAmount: number; totalMg: number };
type Settlement = {
  plannedTotal: number; consumedTotal: number; consumptionRate: number;
  linesRequiringInspection: number; linesInspected: number; inspectionRate: number;
};
type DirFilter = "all" | "payable" | "receivable";
type PendingInspection = {
  id: number; documentNumber: string | null; issueKey: string | null; matterId: number | null;
  matterCode: string | null; matterTitle: string | null; createdAt: string | null; hasInspection: boolean;
};

const directionLabels: Record<string, string> = { payable: "支払", receivable: "受取" };
const flowLabels: Record<string, string> = { in: "イン", out: "アウト" };

function money(currency: string | null, amount: number | null) {
  if (amount === null) return "—";
  return `${currency ?? "JPY"} ${amount.toLocaleString("ja-JP")}`;
}
function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function ConditionLinesWorkspace({ onOpenDocument, onCreateDocument, onNavigate, canRepair = false, initialSelectedId = null, onRecordReceipt }:
  { onOpenDocument?: (documentId: number) => void; onCreateDocument?: (issueKey: string | null) => void;
    onNavigate?: (target: string) => void; canRepair?: boolean; initialSelectedId?: number | null;
    onRecordReceipt?: (conditionLineId: number) => void }) {
  const [tab, setTab] = useState<"search" | "inspections">("search");
  return <section className="page">
    <div className="page-title"><div><p>CONDITION LINES</p><h1>条件明細</h1>
      <small>契約条件の横断検索と、発注書の検収状況を確認します</small></div></div>
    {onNavigate && <div className="surface-xref" role="navigation" aria-label="条件の関連画面">
      <span className="surface-xref-here">閲覧・検収（ここ）</span>
      <button type="button" onClick={() => onNavigate("outbound")}>作成 → アウト条件</button>
      <button type="button" onClick={() => onNavigate("ledgers-conditions")}>マスタ → 台帳（金銭条件）</button>
    </div>}
    <div className="hub-tabs">
      <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>横断検索</button>
      <button className={tab === "inspections" ? "active" : ""} onClick={() => setTab("inspections")}>検収待ち</button>
    </div>
    {tab === "inspections"
      ? <PendingInspections onOpenDocument={onOpenDocument} onCreateDocument={onCreateDocument} />
      : <ConditionSearch onOpenDocument={onOpenDocument} canRepair={canRepair} initialSelectedId={initialSelectedId} onRecordReceipt={onRecordReceipt} />}
  </section>;
}

type Consumption = {
  currency: string | null; plannedTotal: number; consumedTotal: number; balance: number;
  inspectionRequired: boolean; inspectionDone: boolean;
  installments: Array<{ installmentNo: number; triggerKind: string; plannedAmount: number; dueDate: string | null; settled: boolean }>;
  events: Array<{ eventNo: number; eventType: string; occurredAt: string | null; amount: number; period: string | null; documentId: number | null }>;
};
type ConditionDetailData = ConditionLine & {
  matterCode: string | null; matterTitle: string | null; exclusivity: string | null;
  sublicenseAllowed: boolean | null; paymentScheme: string | null; paymentTerms: string | null;
  royaltyBase: string | null; deductibleCosts: string | null; agAmount: number | null;
  notes: string | null; regions: string[]; languages: string[]; consumption: Consumption | null;
};

const triggerLabels: Record<string, string> = {
  on_signing: "契約時", on_delivery: "納品時", on_inspection: "検収時", fixed_date: "期日"
};
const eventTypeLabels: Record<string, string> = {
  inspection: "検収", royalty_calc: "計算", payment: "支払"
};
// 生コード表示の解消（監査指摘）：既知コードはラベル化し、未知値はそのまま表示する。
const exclusivityLabels: Record<string, string> = {
  exclusive: "独占", non_exclusive: "非独占", sole: "独占（単独許諾）"
};
const paymentSchemeLabels: Record<string, string> = {
  royalty: "ロイヤリティ", per_unit: "単価×数量", lump_sum: "一括"
};
const transactionKindLabels: Record<string, string> = {
  license: "ライセンス", product: "商品取引"
};

function ConditionSearch({ onOpenDocument, canRepair = false, initialSelectedId = null, onRecordReceipt }: { onOpenDocument?: (documentId: number) => void; canRepair?: boolean; initialSelectedId?: number | null; onRecordReceipt?: (conditionLineId: number) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DirFilter>("all");
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId);
  const [rows, setRows] = useState<ConditionLine[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    fetch("/api/v2/condition-lines/summary")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { setSummary(data.groups ?? []); setSettlement(data.settlement ?? null); })
      .catch(() => { setSummary([]); setSettlement(null); });
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      fetch(`/api/v2/condition-lines?${new URLSearchParams({ q: query, limit: "300" })}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setRows(data.items ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("条件明細を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, reload]);

  const counts = {
    all: rows.length,
    payable: rows.filter((r) => r.direction === "payable").length,
    receivable: rows.filter((r) => r.direction === "receivable").length
  };
  const chips: Array<{ key: DirFilter; label: string; count: number }> = [
    { key: "all", label: "すべて", count: counts.all },
    { key: "payable", label: "支払", count: counts.payable },
    { key: "receivable", label: "受取", count: counts.receivable }
  ];
  const visible = rows.filter((r) => filter === "all" || r.direction === filter);

  if (selectedId) {
    return <ConditionDetail id={selectedId} onBack={() => setSelectedId(null)} onOpenDocument={onOpenDocument} canRepair={canRepair} onRecordReceipt={onRecordReceipt} />;
  }

  return <>
    <SettlementKpis settlement={settlement} />
    <ConditionSummary summary={summary} />
    <div className="matter-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="条件名、文書番号、相手方、作品名で検索" />
      <span>{loading ? "検索中…" : `${visible.length}件`}</span>
      <ExportButtons filename="condition-lines" sheetName="条件明細" columns={conditionExportColumns} rows={visible} />
    </div>
    <div className="matter-chips">
      {chips.map((chip) => (
        <button key={chip.key} className={`matter-chip ${filter === chip.key ? "active" : ""}`}
          onClick={() => setFilter(chip.key)}>{chip.label}<em>{chip.count}</em></button>
      ))}
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((v) => v + 1)}>再試行</button></div>}
    {!loading && !visible.length
      ? <EmptyState icon="≣" title={rows.length ? "この絞り込みに該当する条件明細はありません" : "条件明細がありません"}
          description={rows.length ? "別の向き・キーワードをお試しください。" : "契約取込・アウト条件追記で登録された条件がここに表示されます。"} />
      : <div className="panel condition-table-wrap">
        <table className="condition-table">
          <thead><tr>
            <th>条件名</th><th>向き</th><th>相手方</th><th>作品</th>
            <th>地域</th><th>金額</th><th>料率</th><th>文書</th>
          </tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className="row-link" onClick={() => setSelectedId(row.id)}>
                <td><b>{row.conditionName || "（無題）"}</b>{row.termStart && <><br /><small>開始 {row.termStart}</small></>}</td>
                <td>
                  <span className={`cond-dir ${row.direction ?? ""}`}>{directionLabels[row.direction ?? ""] ?? "—"}</span>
                  {row.flowDirection && <small> / {flowLabels[row.flowDirection] ?? row.flowDirection}</small>}
                </td>
                <td>{row.vendorName || <span className="cond-missing" title="相手方が未設定です（詳細画面で補修できます）">未設定</span>}</td>
                <td>{row.workTitle || "—"}</td>
                <td>{row.territory || "—"}</td>
                <td>{money(row.currency, row.amountExTax ?? row.mgAmount)}</td>
                <td>{row.ratePct !== null ? `${row.ratePct}%` : "—"}</td>
                <td>{row.documentNumber ?? "未発番"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
  </>;
}

function ConditionDetail({ id, onBack, onOpenDocument, canRepair = false, onRecordReceipt }:
  { id: number; onBack: () => void; onOpenDocument?: (documentId: number) => void; canRepair?: boolean;
    onRecordReceipt?: (conditionLineId: number) => void }) {
  const [detail, setDetail] = useState<ConditionDetailData | null>(null);
  const [error, setError] = useState("");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairVendorId, setRepairVendorId] = useState("");
  const [repairSaving, setRepairSaving] = useState(false);
  const toast = useToast();
  useEffect(() => {
    setDetail(null); setError(""); setRepairOpen(false); setRepairVendorId("");
    fetch(`/api/v2/condition-lines/${id}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setDetail(data.detail))
      .catch(() => setError("条件明細の詳細を取得できませんでした。"));
  }, [id]);

  // 相手方の後付け補修（V1取込データの取引先欠落用・guarded write）。
  async function saveCounterparty() {
    const vendorId = Number(repairVendorId);
    if (!vendorId) return;
    setRepairSaving(true);
    try {
      const response = await fetch(`/api/v2/condition-lines/${id}/counterparty`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "相手方を設定できませんでした。", "error"); return; }
      setDetail((prev) => prev ? { ...prev, vendorName: data.vendorName ?? prev.vendorName } : prev);
      setRepairOpen(false); setRepairVendorId("");
      toast.push(`相手方を「${data.vendorName}」に設定しました。`, "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setRepairSaving(false); }
  }

  return <div>
    <div className="breadcrumb"><button onClick={onBack}>← 条件明細一覧に戻る</button></div>
    {error && <div className="async-error">{error}</div>}
    {!detail && !error && <div className="empty-inline">読み込み中…</div>}
    {detail && <div className="panel condition-detail">
      <div className="matter-detail-head">
        <div><span className="detail-kicker">CONDITION DETAIL</span><h2>{detail.conditionName || "（無題の条件）"}</h2></div>
        {detail.direction === "receivable" && onRecordReceipt &&
          <button className="primary" onClick={() => onRecordReceipt(detail.id)}>受領を記録</button>}
        {detail.documentId && onOpenDocument &&
          <button onClick={() => onOpenDocument(detail.documentId!)}>文書を開く</button>}
      </div>
      <div className="matter-summary">
        <span className={`cond-dir ${detail.direction ?? ""}`}>{directionLabels[detail.direction ?? ""] ?? "—"}</span>
        {detail.flowDirection && <span>{flowLabels[detail.flowDirection] ?? detail.flowDirection}</span>}
        <span>{detail.documentNumber ?? "未発番"}</span>
        {detail.matterCode && <span>{detail.matterCode}</span>}
        {detail.vendorName && <span>{detail.vendorName}</span>}
      </div>
      <dl className="condition-detail-grid">
        <Field label="条件行ID" value={`#${detail.id}`} />
        <Field label="作品" value={detail.workTitle} />
        <div><dt>相手方</dt><dd>
          {detail.vendorName
            ? detail.vendorName
            : <span className="cond-missing">未設定（取込元データに相手方がありません）</span>}
          {canRepair && !repairOpen &&
            <button type="button" className="link-button" onClick={() => setRepairOpen(true)}>
              {detail.vendorName ? "変更" : "設定する"}
            </button>}
        </dd></div>
        <Field label="地域" value={detail.regions.length ? detail.regions.join("、") : detail.territory} />
        <Field label="言語" value={detail.languages.length ? detail.languages.join("、") : null} />
        <Field label="独占性" value={detail.exclusivity ? (exclusivityLabels[detail.exclusivity] ?? detail.exclusivity) : null} />
        <Field label="再許諾" value={detail.sublicenseAllowed === null ? null : detail.sublicenseAllowed ? "可" : "不可"} />
        <Field label="金額(税抜)" value={detail.amountExTax !== null ? money(detail.currency, detail.amountExTax) : null} />
        <Field label="MG" value={detail.mgAmount !== null ? money(detail.currency, detail.mgAmount) : null} />
        <Field label="AG" value={detail.agAmount !== null ? money(detail.currency, detail.agAmount) : null} />
        <Field label="料率" value={detail.ratePct !== null ? `${detail.ratePct}%` : null} />
        <Field label="支払方式" value={detail.paymentScheme ? (paymentSchemeLabels[detail.paymentScheme] ?? detail.paymentScheme) : null} />
        <Field label="支払条件" value={detail.paymentTerms} />
        <Field label="ロイヤリティ基準" value={detail.royaltyBase} />
        <Field label="控除費用" value={detail.deductibleCosts} />
        <Field label="開始日" value={detail.termStart} />
        <Field label="取引種別" value={detail.transactionKind ? (transactionKindLabels[detail.transactionKind] ?? detail.transactionKind) : null} />
      </dl>
      {canRepair && repairOpen && <div className="condition-repair" role="form">
        <h3>相手方の設定</h3>
        <p className="hub-note">取引先マスタから選択して設定します（表示は全画面に即時反映されます）。</p>
        <SearchableLedgerSelect type="vendors" value={repairVendorId}
          label="取引先" placeholder="名前・コードで検索"
          onChange={(value) => setRepairVendorId(value)} />
        <div className="matter-form-actions">
          <button className="primary" disabled={repairSaving || !repairVendorId}
            onClick={() => void saveCounterparty()}>{repairSaving ? "設定中…" : "この取引先に設定"}</button>
          <button type="button" onClick={() => { setRepairOpen(false); setRepairVendorId(""); }}>キャンセル</button>
        </div>
      </div>}
      {detail.consumption && <ConsumptionPanel c={detail.consumption} />}
      {detail.notes && <div className="condition-notes"><h3>備考</h3><p>{detail.notes}</p></div>}
    </div>}
  </div>;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><dt>{label}</dt><dd>{value ? value : "—"}</dd></div>;
}

function ConsumptionPanel({ c }: { c: Consumption }) {
  const pct = c.plannedTotal > 0 ? Math.min(100, Math.round((c.consumedTotal / c.plannedTotal) * 100)) : 0;
  const inspection = !c.inspectionRequired ? "不要" : c.inspectionDone ? "検収済み" : "検収待ち";
  return <div className="condition-consumption">
    <h3>消化・残高</h3>
    <div className="consumption-cards">
      <article><span>予定総額</span><strong>{money(c.currency, c.plannedTotal)}</strong></article>
      <article><span>消化実績</span><strong>{money(c.currency, c.consumedTotal)}</strong></article>
      <article className={c.balance <= 0 ? "settled" : ""}><span>残高</span><strong>{money(c.currency, c.balance)}</strong></article>
      <article><span>検収</span><strong className={inspection === "検収待ち" ? "warn" : ""}>{inspection}</strong></article>
    </div>
    {c.plannedTotal > 0 && <div className="consumption-bar"><div style={{ width: `${pct}%` }} /><small>{pct}% 消化</small></div>}
    {c.installments.length > 0 && <div className="consumption-sub">
      <h4>支払回スケジュール</h4>
      {c.installments.map((i) => <div key={i.installmentNo} className="consumption-row">
        <span>第{i.installmentNo}回・{triggerLabels[i.triggerKind] ?? i.triggerKind}</span>
        <span>{money(c.currency, i.plannedAmount)}</span>
        <span>{i.dueDate ?? "期日未定"}</span>
        <span className={i.settled ? "settled-tag" : "pending-tag"}>{i.settled ? "精算済" : "未精算"}</span>
      </div>)}
    </div>}
    {c.events.length > 0 && <div className="consumption-sub">
      <h4>実績イベント</h4>
      {c.events.slice(0, 8).map((e) => <div key={e.eventNo} className="consumption-row">
        <span>{eventTypeLabels[e.eventType] ?? e.eventType}{e.period ? `・${e.period}` : ""}</span>
        <span>{money(c.currency, e.amount)}</span>
        <span>{e.occurredAt ? formatDate(e.occurredAt) : "—"}</span>
      </div>)}
    </div>}
  </div>;
}

function SettlementKpis({ settlement }: { settlement: Settlement | null }) {
  if (!settlement) return null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return <div className="settlement-kpis">
    <article><span>消化率</span><strong>{pct(settlement.consumptionRate)}</strong>
      <small>{settlement.consumedTotal.toLocaleString("ja-JP")} / {settlement.plannedTotal.toLocaleString("ja-JP")}</small></article>
    <article className={settlement.inspectionRate < 1 && settlement.linesRequiringInspection > 0 ? "warn" : ""}>
      <span>検収率</span><strong>{settlement.linesRequiringInspection ? pct(settlement.inspectionRate) : "—"}</strong>
      <small>{settlement.linesInspected} / {settlement.linesRequiringInspection} 明細</small></article>
    <article><span>残高</span><strong>{(settlement.plannedTotal - settlement.consumedTotal).toLocaleString("ja-JP")}</strong>
      <small>予定 − 消化</small></article>
  </div>;
}

function ConditionSummary({ summary }: { summary: SummaryRow[] }) {
  if (!summary.length) return null;
  const cards = (["receivable", "payable"] as const).map((dir) => {
    const groups = summary.filter((s) => s.direction === dir);
    return {
      dir,
      label: directionLabels[dir],
      count: groups.reduce((sum, g) => sum + g.lineCount, 0),
      amounts: groups.filter((g) => g.totalAmount > 0).map((g) => money(g.currency, g.totalAmount))
    };
  }).filter((card) => card.count > 0);
  if (!cards.length) return null;
  return <div className="condition-summary-cards">
    {cards.map((card) => (
      <article key={card.dir} className={`cond-summary ${card.dir}`}>
        <span>{card.label}</span>
        <strong>{card.amounts.length ? card.amounts.join(" / ") : "金額未設定"}</strong>
        <small>{card.count}件</small>
      </article>
    ))}
  </div>;
}

function PendingInspections({ onOpenDocument, onCreateDocument }:
  { onOpenDocument?: (documentId: number) => void; onCreateDocument?: (issueKey: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [onlyPending, setOnlyPending] = useState(true);
  const [rows, setRows] = useState<PendingInspection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      const params = new URLSearchParams({ q: query, pending: onlyPending ? "1" : "0", limit: "300" });
      fetch(`/api/v2/pending-inspections?${params}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setRows(data.items ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("検収待ちを取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, onlyPending, reload]);

  return <>
    <p className="hub-note">発注書のうち、同じ案件・課題に検収書が未作成のものを検収待ちとして表示します（文書単位の簡易判定。明細ごとの検収率は今後追加）。</p>
    <div className="matter-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="発注書番号・課題キー・案件で検索" />
      <span>{loading ? "検索中…" : `${rows.length}件`}</span>
      <ExportButtons filename="pending-inspections" sheetName="検収待ち" columns={inspectionExportColumns} rows={rows} />
    </div>
    <div className="matter-chips">
      <button className={`matter-chip ${onlyPending ? "active" : ""}`} onClick={() => setOnlyPending(true)}>検収書未作成のみ</button>
      <button className={`matter-chip ${!onlyPending ? "active" : ""}`} onClick={() => setOnlyPending(false)}>すべての発注書</button>
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((v) => v + 1)}>再試行</button></div>}
    {!loading && !rows.length
      ? <EmptyState icon="✓" title={onlyPending ? "検収待ちの発注書はありません" : "発注書がありません"}
          description={onlyPending ? "すべての発注書に検収書が作成済みです。" : "発注書が作成されるとここに表示されます。"} />
      : <div className="panel condition-table-wrap">
        <table className="condition-table">
          <thead><tr><th>発注書番号</th><th>案件</th><th>課題</th><th>作成日</th><th>検収書</th><th></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="row-link" onClick={() => onOpenDocument?.(row.id)}>
                  <b>{row.documentNumber ?? "未発番"}</b></td>
                <td>{row.matterCode ? `${row.matterCode}` : "—"}{row.matterTitle && <><br /><small>{row.matterTitle}</small></>}</td>
                <td>{row.issueKey || "—"}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td>{row.hasInspection
                  ? <span className="cond-dir receivable">作成済み</span>
                  : <span className="cond-dir payable">未作成</span>}</td>
                <td>{!row.hasInspection && onCreateDocument &&
                  <button className="inline-cta" onClick={() => onCreateDocument(row.issueKey)}>検収書を作成</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
  </>;
}
