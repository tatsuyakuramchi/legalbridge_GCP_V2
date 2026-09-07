import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import { useToast } from "./Toast";
import { ExportButtons } from "./ExportButtons";
import type { ExportColumn } from "./export-util";
import { MultiSelectChips } from "./MultiSelectChips";
import { LANGUAGE_GROUPS, TERRITORY_GROUPS } from "./territory-master";
import type { CodedName } from "../condition-ledger";

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
  // 有効性（巻き直しの旧版・無効化文書の条件は無効＝計算書の下地にならない）。
  effective?: boolean; supersededBy?: string | null;
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

export function ConditionLinesWorkspace({ onOpenDocument, onCreateDocument, onNavigate, canRepair = false, initialSelectedId = null, onRecordReceipt, onEditLedger }:
  { onOpenDocument?: (documentId: number) => void; onCreateDocument?: (issueKey: string | null) => void;
    onNavigate?: (target: string) => void; canRepair?: boolean; initialSelectedId?: number | null; onEditLedger?: (ledgerId: number) => void;
    onRecordReceipt?: (conditionLineId: number) => void }) {
  const [tab, setTab] = useState<"search" | "inspections">("search");
  return <section className="page">
    <div className="page-title"><div><p>CONDITION LINES</p><h1>条件明細</h1>
      <small>契約条件の横断検索と、発注書の検収状況を確認します</small></div></div>
    {onNavigate && <div className="surface-xref" role="navigation" aria-label="条件の関連画面">
      <span className="surface-xref-here">閲覧・検収（ここ）</span>
      <button type="button" onClick={() => onNavigate("condition-first")}>作成 → 条件を登録する</button>
      <button type="button" onClick={() => onNavigate("ledgers-conditions")}>マスタ → 台帳（金銭条件）</button>
    </div>}
    <div className="hub-tabs">
      <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>横断検索</button>
      <button className={tab === "inspections" ? "active" : ""} onClick={() => setTab("inspections")}>検収待ち</button>
    </div>
    {tab === "inspections"
      ? <PendingInspections onOpenDocument={onOpenDocument} onCreateDocument={onCreateDocument} />
      : <ConditionSearch onOpenDocument={onOpenDocument} canRepair={canRepair} initialSelectedId={initialSelectedId} onRecordReceipt={onRecordReceipt} onEditLedger={onEditLedger} />}
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

function ConditionSearch({ onOpenDocument, canRepair = false, initialSelectedId = null, onRecordReceipt, onEditLedger }: { onOpenDocument?: (documentId: number) => void; canRepair?: boolean; initialSelectedId?: number | null; onRecordReceipt?: (conditionLineId: number) => void; onEditLedger?: (ledgerId: number) => void }) {
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
    return <ConditionDetail id={selectedId} onBack={() => setSelectedId(null)} onOpenDocument={onOpenDocument} canRepair={canRepair} onRecordReceipt={onRecordReceipt} onEditLedger={onEditLedger} />;
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
          description={rows.length ? "別の向き・キーワードをお試しください。" : "「条件を登録する」（条件台帳）や契約取込で登録された条件がここに表示されます。"} />
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
                <td>{row.documentNumber ?? "未発番"}
                  {row.effective === false && <><br /><span className="cond-ineffective"
                    title={row.supersededBy ? `巻き直し済み。有効版は ${row.supersededBy}` : "無効化された文書の条件"}>
                    無効{row.supersededBy ? `（旧版 → ${row.supersededBy}）` : ""}</span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
  </>;
}

type LinkedDoc = { id: number; documentNumber: string | null; templateType: string | null; lifecycleStatus: string | null; title: string | null };
type DocHit = { id: number; documentNumber: string | null; templateType: string | null; title?: string | null; counterparty?: string | null; lifecycleStatus?: string | null };

// 文書の検索・選択（元文書の付け替え／台帳への紐づけ）。登録文書一覧 API を使う。
function DocumentPicker({ label, excludeIds = [], onPick }: { label: string; excludeIds?: number[]; onPick: (doc: DocHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetch(`/api/v2/documents?q=${encodeURIComponent(query.trim())}&limit=20&lifecycle=active`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : { documents: [] })
        .then((data: { documents?: DocHit[] }) => setHits((data.documents ?? []).filter((d) => !excludeIds.includes(d.id))))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return <div className="document-picker">
    <label><span>{label}</span>
      <input value={query} placeholder="文書番号・件名・相手先で検索（2文字以上）" onChange={(event) => setQuery(event.target.value)} /></label>
    {loading && <small className="muted">検索中…</small>}
    {hits.length > 0 && <ul className="document-picker-hits">
      {hits.map((doc) => <li key={doc.id}>
        <button type="button" onClick={() => { onPick(doc); setQuery(""); setHits([]); }}>
          <b>{doc.documentNumber ?? `#${doc.id}`}</b> {doc.title || ""}{doc.counterparty ? `（${doc.counterparty}）` : ""}
          <small> {doc.templateType ?? ""}</small>
        </button>
      </li>)}
    </ul>}
  </div>;
}

type EditForm = {
  conditionName: string; currency: string; amountExTax: string; mgAmount: string; agAmount: string; ratePct: string;
  termStart: string; exclusivity: string; sublicenseAllowed: "" | "true" | "false"; paymentScheme: string;
  paymentTerms: string; royaltyBase: string; deductibleCosts: string; notes: string; transactionKind: string;
  regions: CodedName[]; languages: CodedName[];
  documentId: number | null; documentNumber: string | null;
};
const toForm = (d: ConditionDetailData): EditForm => ({
  conditionName: d.conditionName ?? "", currency: d.currency ?? "JPY",
  amountExTax: d.amountExTax == null ? "" : String(d.amountExTax),
  mgAmount: d.mgAmount == null ? "" : String(d.mgAmount),
  agAmount: d.agAmount == null ? "" : String(d.agAmount),
  ratePct: d.ratePct == null ? "" : String(d.ratePct),
  termStart: d.termStart ?? "", exclusivity: d.exclusivity ?? "",
  sublicenseAllowed: d.sublicenseAllowed == null ? "" : d.sublicenseAllowed ? "true" : "false",
  paymentScheme: d.paymentScheme ?? "", paymentTerms: d.paymentTerms ?? "", royaltyBase: d.royaltyBase ?? "",
  deductibleCosts: d.deductibleCosts ?? "", notes: d.notes ?? "", transactionKind: d.transactionKind ?? "",
  regions: (d.regions.length ? d.regions : legacyNames(d.territory)).map((name) => ({ code: null, name })),
  languages: d.languages.map((name) => ({ code: null, name })),
  documentId: d.documentId, documentNumber: d.documentNumber
});
const legacyNames = (value: string | null | undefined) =>
  String(value ?? "").split(/[,、/・]/).map((s) => s.trim()).filter(Boolean);

function ConditionDetail({ id, onBack, onOpenDocument, canRepair = false, onRecordReceipt, onEditLedger }:
  { id: number; onBack: () => void; onOpenDocument?: (documentId: number) => void; canRepair?: boolean;
    onRecordReceipt?: (conditionLineId: number) => void; onEditLedger?: (ledgerId: number) => void }) {
  const [detail, setDetail] = useState<ConditionDetailData | null>(null);
  const [error, setError] = useState("");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairVendorId, setRepairVendorId] = useState("");
  const [repairSaving, setRepairSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [linked, setLinked] = useState<LinkedDoc[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const toast = useToast();
  const isLedger = detail?.templateType === "condition_ledger";

  const load = () => fetch(`/api/v2/condition-lines/${id}`)
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((data) => setDetail(data.detail))
    .catch(() => setError("条件明細の詳細を取得できませんでした。"));
  useEffect(() => {
    setDetail(null); setError(""); setRepairOpen(false); setRepairVendorId(""); setEditing(false); setForm(null); setLinked(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // 条件台帳（CT-…）の条件明細なら、台帳に紐づく文書（過去文書・アップロード・確定文書）も出す。
  const loadLinked = (ledgerId: number) => fetch(`/api/v2/condition-ledgers/${ledgerId}`)
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((data) => setLinked(data.ledger?.linkedDocuments ?? []))
    .catch(() => setLinked([]));
  useEffect(() => {
    if (isLedger && detail?.documentId) void loadLinked(detail.documentId);
  }, [isLedger, detail?.documentId]);

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

  // 項目単位の編集（PATCH /condition-lines/:id・guarded write）。
  async function saveEdit() {
    if (!form || !detail) return;
    const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/,/g, "")));
    const text = (v: string) => (v.trim() === "" ? null : v.trim());
    const body = {
      conditionName: form.conditionName.trim(),
      currency: text(form.currency), amountExTax: num(form.amountExTax), mgAmount: num(form.mgAmount),
      agAmount: num(form.agAmount), ratePct: num(form.ratePct), termStart: form.termStart || null,
      exclusivity: text(form.exclusivity),
      sublicenseAllowed: form.sublicenseAllowed === "" ? null : form.sublicenseAllowed === "true",
      paymentScheme: text(form.paymentScheme), paymentTerms: text(form.paymentTerms), royaltyBase: text(form.royaltyBase),
      deductibleCosts: text(form.deductibleCosts), notes: text(form.notes), transactionKind: text(form.transactionKind),
      regions: form.regions, languages: form.languages,
      ...(form.documentId !== detail.documentId ? { documentId: form.documentId } : {})
    };
    setSaving(true);
    try {
      const response = await fetch(`/api/v2/condition-lines/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "保存できませんでした。", "error"); return; }
      if (data.detail) setDetail(data.detail); else await load();
      setEditing(false); setForm(null);
      toast.push("条件明細を更新しました。", "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  async function attach(doc: DocHit) {
    if (!detail?.documentId) return;
    setLinkBusy(true);
    try {
      const response = await fetch(`/api/v2/condition-ledgers/${detail.documentId}/attach`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: doc.id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "紐づけできませんでした。", "error"); return; }
      await loadLinked(detail.documentId);
      toast.push(`${doc.documentNumber ?? `#${doc.id}`} を台帳に紐づけました。`, "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setLinkBusy(false); }
  }
  async function detach(doc: LinkedDoc) {
    if (!detail?.documentId) return;
    if (!window.confirm(`${doc.documentNumber ?? `#${doc.id}`} の紐づけを解除しますか？（文書自体は消えません）`)) return;
    setLinkBusy(true);
    try {
      const response = await fetch(`/api/v2/condition-ledgers/${detail.documentId}/detach`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: doc.id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "解除できませんでした。", "error"); return; }
      await loadLinked(detail.documentId);
      toast.push("紐づけを解除しました。", "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setLinkBusy(false); }
  }

  const set = (patch: Partial<EditForm>) => setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  const textField = (key: keyof EditForm, label: string, opts: { type?: string; placeholder?: string } = {}) =>
    <label key={String(key)}><span>{label}</span>
      <input type={opts.type ?? "text"} value={String(form?.[key] ?? "")} placeholder={opts.placeholder}
        onChange={(event) => set({ [key]: event.target.value } as Partial<EditForm>)} /></label>;

  return <div>
    <div className="breadcrumb"><button onClick={onBack}>← 条件明細一覧に戻る</button></div>
    {error && <div className="async-error">{error}</div>}
    {!detail && !error && <div className="empty-inline">読み込み中…</div>}
    {detail && <div className="panel condition-detail">
      <div className="matter-detail-head">
        <div><span className="detail-kicker">CONDITION DETAIL</span><h2>{detail.conditionName || "（無題の条件）"}</h2></div>
        <div className="actions">
          {canRepair && !editing &&
            <button onClick={() => { setForm(toForm(detail)); setEditing(true); }}>編集</button>}
          {isLedger && detail.documentId && onEditLedger &&
            <button onClick={() => onEditLedger(detail.documentId!)} title="条件台帳（条件を登録する）を編集モードで開く。行の追加・削除や文書の扱いはこちら">台帳で編集</button>}
          {detail.direction === "receivable" && onRecordReceipt &&
            <button className="primary" onClick={() => onRecordReceipt(detail.id)}>受領を記録</button>}
          {detail.documentId && onOpenDocument &&
            <button onClick={() => onOpenDocument(detail.documentId!)}>文書を開く</button>}
        </div>
      </div>
      <div className="matter-summary">
        <span className={`cond-dir ${detail.direction ?? ""}`}>{directionLabels[detail.direction ?? ""] ?? "—"}</span>
        {detail.flowDirection && <span>{flowLabels[detail.flowDirection] ?? detail.flowDirection}</span>}
        <span>{detail.documentNumber ?? "未発番"}</span>
        {detail.effective === false && <span className="cond-ineffective">
          無効{detail.supersededBy ? `（巻き直し済み・有効版 ${detail.supersededBy}）` : "（無効化文書）"}— 計算書の下地には使えません</span>}
        {detail.matterCode && <span>{detail.matterCode}</span>}
        {detail.vendorName && <span>{detail.vendorName}</span>}
      </div>

      {editing && form && <div className="condition-edit" role="form">
        <h3>条件明細の編集</h3>
        <p className="hub-note">保存すると条件台帳・計算書・作品画面のすべてに反映されます。金額は税抜。地域・言語は候補から追加（自由入力も可）。</p>
        <div className="field-grid">
          {textField("conditionName", "条件名")}
          <label><span>取引種別</span>
            <select value={form.transactionKind} onChange={(event) => set({ transactionKind: event.target.value })}>
              <option value="">—</option><option value="license">ライセンス</option><option value="product">商品取引</option>
            </select></label>
          {textField("currency", "通貨", { placeholder: "JPY" })}
          {textField("amountExTax", "金額（税抜）", { type: "number" })}
          {textField("ratePct", "料率（%）", { type: "number" })}
          {textField("mgAmount", "MG", { type: "number" })}
          {textField("agAmount", "AG", { type: "number" })}
          {textField("termStart", "開始日", { type: "date" })}
          <label><span>独占性</span>
            <select value={form.exclusivity} onChange={(event) => set({ exclusivity: event.target.value })}>
              <option value="">—</option>
              {Object.entries(exclusivityLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          <label><span>再許諾</span>
            <select value={form.sublicenseAllowed} onChange={(event) => set({ sublicenseAllowed: event.target.value as EditForm["sublicenseAllowed"] })}>
              <option value="">—</option><option value="true">可</option><option value="false">不可</option>
            </select></label>
          <label><span>支払方式</span>
            <select value={form.paymentScheme} onChange={(event) => set({ paymentScheme: event.target.value })}>
              <option value="">—</option>
              {Object.entries(paymentSchemeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          {textField("paymentTerms", "支払条件")}
          {textField("royaltyBase", "ロイヤリティ基準")}
          {textField("deductibleCosts", "控除費用")}
        </div>
        <div className="field-grid">
          <label><span>許諾地域</span>
            <MultiSelectChips value={form.regions} groups={TERRITORY_GROUPS} placeholder="国・地域を検索して追加"
              onChange={(next) => set({ regions: next })} /></label>
          <label><span>許諾言語</span>
            <MultiSelectChips value={form.languages} groups={LANGUAGE_GROUPS} placeholder="言語を検索して追加"
              onChange={(next) => set({ languages: next })} /></label>
        </div>
        <label><span>備考</span>
          <textarea rows={3} value={form.notes} onChange={(event) => set({ notes: event.target.value })} /></label>
        {!isLedger && <div className="condition-edit-doc">
          <h4>元文書（この条件明細が属する文書）</h4>
          <p className="hub-note">現在: <b>{form.documentNumber ?? (form.documentId ? `#${form.documentId}` : "未紐づけ")}</b>
            {form.documentId !== detail.documentId && <em>（変更あり・保存で反映）</em>}</p>
          <DocumentPicker label="別の文書に付け替える" excludeIds={form.documentId ? [form.documentId] : []}
            onPick={(doc) => set({ documentId: doc.id, documentNumber: doc.documentNumber })} />
          {form.documentId && <button type="button" className="link-button" onClick={() => set({ documentId: null, documentNumber: null })}>紐づけを外す（元文書なし）</button>}
        </div>}
        <div className="matter-form-actions">
          <button className="primary" disabled={saving || !form.conditionName.trim()} onClick={() => void saveEdit()}>{saving ? "保存中…" : "保存"}</button>
          <button type="button" disabled={saving} onClick={() => { setEditing(false); setForm(null); }}>キャンセル</button>
        </div>
      </div>}

      {!editing && <dl className="condition-detail-grid">
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
        <Field label="元文書" value={detail.documentNumber ?? (detail.documentId ? `#${detail.documentId}` : null)} />
      </dl>}
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

      {isLedger && detail.documentId && <div className="condition-linked-docs">
        <h3>台帳に紐づく文書</h3>
        <p className="hub-note">この条件明細の台帳（{detail.documentNumber}）に紐づく契約書・発注書・アップロード文書。紐づけると文書側に台帳番号が記録され、後続文書や作品画面から辿れます。</p>
        {linked === null && <div className="empty-inline">読み込み中…</div>}
        {linked && !linked.length && <p className="inline-empty">紐づく文書はまだありません。</p>}
        {linked && linked.length > 0 && <ul className="linked-doc-list">
          {linked.map((doc) => <li key={doc.id}>
            <b>{doc.documentNumber ?? `#${doc.id}`}</b> {doc.title || ""} <small>{doc.templateType ?? ""}{doc.lifecycleStatus ? `・${doc.lifecycleStatus}` : ""}</small>
            {onOpenDocument && <button type="button" className="link-button" onClick={() => onOpenDocument(doc.id)}>開く</button>}
            {canRepair && <button type="button" className="link-button" disabled={linkBusy} onClick={() => void detach(doc)}>解除</button>}
          </li>)}
        </ul>}
        {canRepair && <DocumentPicker label="文書を紐づける" excludeIds={[detail.documentId, ...(linked ?? []).map((d) => d.id)]} onPick={(doc) => void attach(doc)} />}
      </div>}

      {detail.consumption && <ConsumptionPanel c={detail.consumption} />}
      {!editing && detail.notes && <div className="condition-notes"><h3>備考</h3><p>{detail.notes}</p></div>}
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
