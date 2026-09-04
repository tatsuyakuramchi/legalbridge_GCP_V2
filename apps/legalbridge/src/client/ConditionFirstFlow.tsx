import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "./Toast";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import { MultiSelectChips } from "./MultiSelectChips";
import { DocQuotePicker } from "./WorkIntake";
import { INTAKE_DOC_KINDS, businessLineLabel } from "./work-intake";
import { LANGUAGE_GROUPS, TERRITORY_GROUPS } from "./territory-master";
import {
  LEDGER_KIND_OPTIONS, PAYMENT_SCHEME_OPTIONS, TAX_CATEGORY_OPTIONS, emptyExpenseRow, emptyFeeRow, emptyLedgerPayload,
  emptyLicenseRow, emptyPaymentRow, groupRateSums, ledgerDocumentChoices, ledgerTaxSummary,
  type ConditionLedgerPayload, type LedgerExpenseRow, type LedgerFeeRow, type LedgerKind, type LedgerLicenseRow,
  type LedgerPaymentRow, type TaxCategory
} from "../condition-ledger";

// 条件を正にする新フロー（2026-09-04）。
//   ① 入口 — 新規（作品と無関係）／作品（既存を検索・新規登録へ）／条件明細なし（従来の文書作成へ）
//   ② 条件明細 — 業務委託用（支払＋経費＋手数料・税区分）／利用許諾イン／利用許諾アウト を複数選んで作成。
//      保存で条件台帳（CT-…）と条件明細（condition_lines）へ直接書く。一時保存（下書き）→「続きから」。
//   ③ 文書の扱い — 新規文書に紐づける（従来フォームへ引き渡し・確定時は紐づけのみ＝条件は二重にならない）／
//      過去文書に紐づける／アップロード文書に紐づける。
// 検収書・利用許諾料計算書は時間差で依頼が来るためこのフローに含めない（別画面「後続文書」から契約を呼び出す）。

type Material = { id: number; materialCode: string | null; materialName: string | null; materialRole: string | null };
type WorkInfo = { id: number; workCode: string | null; title: string; businessLine: string | null; materials: Material[] };
type LedgerSummary = {
  id: number; documentNumber: string; title: string; vendorName: string; workId: number | null; workCode: string | null;
  workTitle: string; kinds: string[]; status: "draft" | "final"; lineCount: number; linkedCount: number; updatedAt: string | null;
};
type LinkedDocument = { id: number; documentNumber: string | null; templateType: string | null; templateVersionId: number | null; lifecycleStatus: string | null; title: string | null };
type LedgerDetail = LedgerSummary & {
  payload: ConditionLedgerPayload;
  lines: Array<{ id: number; lineNo: number | null; lineCode: string | null; lineKind: string; conditionName: string | null }>;
  linkedDocuments: LinkedDocument[];
};

export interface LedgerHandoff { id: number; documentNumber: string; lineCodes: Record<number, string> }

const DOC_KIND_LABELS: Record<string, string> = {
  ...Object.fromEntries(INTAKE_DOC_KINDS.map((k) => [k.value, k.label])),
  individual_license_terms_v3: "個別利用許諾条件書", pub_license_terms: "出版個別利用許諾条件書",
  royalty_statement: "利用許諾料計算書", inspection_certificate: "検収書", license_out_en: "ライセンスアウト契約（英文）",
  condition_ledger: "条件台帳"
};

const toNum = (v: string): number | null => {
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return v.trim() === "" || !Number.isFinite(n) ? null : n;
};
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const fmtDate = (v: string | null) => (v ? v.slice(0, 10) : "");

export function ConditionFirstFlow({ seed, canWrite, onBack, onOpenWork, onRegisterWork, onOpenTemplates, onCreateDocument }: {
  seed: { workId?: number | null; ledgerId?: number | null };
  canWrite: boolean;
  onBack: () => void;
  onOpenWork: (workId: number) => void;
  onRegisterWork: () => void;
  onOpenTemplates: () => void;
  onCreateDocument: (templateKey: string, payload: ConditionLedgerPayload, ledger: LedgerHandoff) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [payload, setPayload] = useState<ConditionLedgerPayload>(() => ({ ...emptyLedgerPayload(), entry: seed.workId ? "work" : "new" }));
  const [work, setWork] = useState<WorkInfo | null>(null);
  const [ledger, setLedger] = useState<LedgerDetail | null>(null);
  const [drafts, setDrafts] = useState<LedgerSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [attachMode, setAttachMode] = useState<"new" | "past" | "upload">("new");
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadMeta, setUploadMeta] = useState({ templateType: "purchase_order", docNumber: "", date: "" });

  const update = (patch: Partial<ConditionLedgerPayload>) => { setPayload((p) => ({ ...p, ...patch })); setDirty(true); };

  async function loadWork(workId: number) {
    const response = await fetch(`/api/v2/works/${workId}/detail`);
    if (!response.ok) { setError("作品を読み込めませんでした"); return null; }
    const detail = await response.json();
    const info: WorkInfo = {
      id: workId, workCode: detail.work?.workCode ?? null, title: String(detail.work?.title ?? ""),
      businessLine: detail.work?.businessLine ?? null,
      materials: (detail.materials ?? []).map((m: Record<string, unknown>) => ({
        id: Number(m.id), materialCode: (m.materialCode as string | null) ?? null,
        materialName: (m.materialName as string | null) ?? null, materialRole: (m.materialRole as string | null) ?? null
      }))
    };
    setWork(info);
    return info;
  }
  async function loadDrafts(workId: number | null) {
    const params = new URLSearchParams({ status: "draft", limit: "30" });
    if (workId) params.set("workId", String(workId));
    const response = await fetch(`/api/v2/condition-ledgers?${params}`);
    if (response.ok) setDrafts((await response.json()).ledgers ?? []);
  }
  async function resume(ledgerId: number) {
    setError("");
    const response = await fetch(`/api/v2/condition-ledgers/${ledgerId}`);
    if (!response.ok) { setError("条件台帳を読み込めませんでした"); return; }
    const detail: LedgerDetail = (await response.json()).ledger;
    setLedger(detail);
    setPayload({ ...emptyLedgerPayload(), ...detail.payload });
    if (detail.workId) await loadWork(detail.workId);
    setDirty(false);
    setStep(2);
  }

  useEffect(() => {
    if (seed.ledgerId) { void resume(seed.ledgerId); return; }
    if (seed.workId) {
      void loadWork(seed.workId).then((info) => {
        if (info) update({ entry: "work", workId: info.id, workCode: info.workCode, workTitle: info.title });
      });
    }
    void loadDrafts(seed.workId ?? null);
  }, [seed.workId, seed.ledgerId]);

  async function pickWork(value: string) {
    const workId = Number(value);
    if (!workId) { setWork(null); update({ workId: null, workCode: null, workTitle: "" }); void loadDrafts(null); return; }
    const info = await loadWork(workId);
    if (info) update({ workId: info.id, workCode: info.workCode, workTitle: info.title });
    void loadDrafts(workId);
  }

  const materialOptions = useMemo(() => {
    const sorted = [...(work?.materials ?? [])].sort((a, b) =>
      (a.materialRole === "core_logic" ? 0 : 1) - (b.materialRole === "core_logic" ? 0 : 1));
    return sorted.filter((m) => m.materialCode).map((m) => ({
      value: m.materialCode as string,
      label: `${m.materialRole === "core_logic" ? "★原作 " : ""}${m.materialName ?? ""}（${m.materialCode}）`
    }));
  }, [work]);

  const tax = ledgerTaxSummary(payload);
  const hasKind = (k: LedgerKind) => payload.kinds.includes(k);
  const rowCount = (hasKind("service") ? payload.payments.length + payload.expenses.length + payload.fees.length : 0)
    + (hasKind("license_in") ? payload.licenseIn.length : 0) + (hasKind("license_out") ? payload.licenseOut.length : 0);

  function validate(final: boolean): string | null {
    if (!payload.vendorId) return "相手先（取引先マスタ）を選んでください";
    if (!payload.kinds.length) return "条件明細の種類を1つ以上選んでください";
    if (final && rowCount === 0) return "条件明細の行を1つ以上入れてください（下書きなら空でも保存できます）";
    return null;
  }

  async function save(status: "draft" | "final"): Promise<LedgerDetail | null> {
    const problem = validate(status === "final");
    if (problem) { setError(problem); return null; }
    setSaving(true); setError("");
    try {
      const body = { ...payload, status };
      const response = await fetch(ledger ? `/api/v2/condition-ledgers/${ledger.id}` : "/api/v2/condition-ledgers", {
        method: ledger ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error === "invalid request" ? `入力に誤りがあります: ${(data.issues ?? []).map((i: { message: string }) => i.message).join(" / ")}` : (data.error ?? "保存に失敗しました"));
        return null;
      }
      const detailResponse = await fetch(`/api/v2/condition-ledgers/${data.ledger.id}`);
      const detail: LedgerDetail = detailResponse.ok ? (await detailResponse.json()).ledger : { ...data.ledger, payload: body, lines: [], linkedDocuments: [] };
      setLedger(detail);
      setPayload((p) => ({ ...p, status }));
      setDirty(false);
      if (data.conditionSyncWarning) toast.push(`${detail.documentNumber} を保存しました。⚠ ${data.conditionSyncWarning}`, "info");
      else toast.push(`${detail.documentNumber} を${status === "draft" ? "下書き保存" : "保存"}し、条件明細 ${data.conditionSync?.written ?? 0}件を台帳へ登録しました`, "success");
      return detail;
    } catch { setError("通信に失敗しました"); return null; }
    finally { setSaving(false); }
  }

  async function refreshLedger() {
    if (!ledger) return;
    const response = await fetch(`/api/v2/condition-ledgers/${ledger.id}`);
    if (response.ok) setLedger((await response.json()).ledger);
  }

  function handoff(): LedgerHandoff | null {
    if (!ledger) return null;
    const lineCodes: Record<number, string> = {};
    ledger.lines.forEach((l) => { if (l.lineNo != null && l.lineCode) lineCodes[l.lineNo] = l.lineCode; });
    return { id: ledger.id, documentNumber: ledger.documentNumber, lineCodes };
  }

  async function attachDocument(documentId: number, label: string) {
    if (!ledger) return;
    const response = await fetch(`/api/v2/condition-ledgers/${ledger.id}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { toast.push(data.error ?? "紐づけに失敗しました", "error"); return; }
    toast.push(`${label} を ${ledger.documentNumber} に紐づけました`, "success");
    await refreshLedger();
  }
  async function detachDocument(doc: LinkedDocument) {
    if (!ledger) return;
    const response = await fetch(`/api/v2/condition-ledgers/${ledger.id}/detach`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: doc.id })
    });
    if (!response.ok) { toast.push("解除に失敗しました", "error"); return; }
    await refreshLedger();
  }
  async function upload() {
    if (!pendingFile || !ledger) return;
    if (!uploadMeta.docNumber.trim()) { toast.push("文書番号を入力してください", "error"); return; }
    setSaving(true);
    try {
      const form = new FormData();
      form.append("file", pendingFile);
      form.append("originalName", pendingFile.name);
      form.append("documentNumber", uploadMeta.docNumber.trim());
      form.append("templateType", uploadMeta.templateType);
      form.append("title", pendingFile.name.replace(/\.[A-Za-z0-9]{1,8}$/, ""));
      if (uploadMeta.date) form.append("documentDate", uploadMeta.date);
      if (payload.workCode) form.append("workCode", payload.workCode);
      if (payload.vendorId) form.append("counterpartyVendorId", String(payload.vendorId));
      if (payload.vendorName) form.append("counterparty", payload.vendorName);
      const response = await fetch("/api/v2/documents/import/upload", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "アップロードに失敗しました", "error"); return; }
      const created = Number(data.document?.id);
      if (created) await attachDocument(created, uploadMeta.docNumber.trim());
      setPendingFile(null); setUploadMeta({ templateType: "purchase_order", docNumber: "", date: "" });
    } catch { toast.push("通信に失敗しました", "error"); }
    finally { setSaving(false); }
  }

  // ── 行エディタ ─────────────────────────────────────────────────────────
  const materialSelect = (value: string, onChange: (v: string) => void) => <select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">{work ? "文書全体（素材を特定しない）" : "（作品なし）"}</option>
    {materialOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>;

  const setRows = <K extends "payments" | "expenses" | "fees" | "licenseIn" | "licenseOut">(key: K, rows: ConditionLedgerPayload[K]) => update({ [key]: rows } as Partial<ConditionLedgerPayload>);
  const edit = <T,>(rows: T[], index: number, patch: Partial<T>): T[] => rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
  const drop = <T,>(rows: T[], index: number): T[] => rows.filter((_, i) => i !== index);

  const paymentsTable = <table className="cf-table"><thead><tr><th style={{ width: 150 }}>支払方式</th><th style={{ width: 210 }}>対象（成果物・素材）</th><th>内容</th><th style={{ width: 120 }}>金額（税抜）</th><th style={{ width: 150 }}>支払時期</th><th style={{ width: 34 }}></th></tr></thead>
    <tbody>{payload.payments.map((row, i) => <tr key={i}>
      <td><select value={row.scheme} onChange={(e) => setRows("payments", edit(payload.payments, i, { scheme: e.target.value as LedgerPaymentRow["scheme"] }))}>
        {PAYMENT_SCHEME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
      <td>{materialSelect(row.materialCode, (v) => setRows("payments", edit(payload.payments, i, { materialCode: v })))}</td>
      <td><input value={row.name} placeholder="例: イラスト制作費" onChange={(e) => setRows("payments", edit(payload.payments, i, { name: e.target.value }))} /></td>
      <td><input inputMode="numeric" value={row.amountExTax ?? ""} onChange={(e) => setRows("payments", edit(payload.payments, i, { amountExTax: toNum(e.target.value) }))} /></td>
      <td><input value={row.paymentTerms} placeholder="納品月の翌月末" onChange={(e) => setRows("payments", edit(payload.payments, i, { paymentTerms: e.target.value }))} /></td>
      <td><button type="button" className="link-button" onClick={() => setRows("payments", drop(payload.payments, i))}>×</button></td>
    </tr>)}</tbody></table>;

  const taxSelect = (value: TaxCategory, onChange: (v: TaxCategory) => void) => <select value={value} onChange={(e) => onChange(e.target.value as TaxCategory)}>
    {TAX_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;

  const expensesTable = <table className="cf-table"><thead><tr><th>項目</th><th style={{ width: 120 }}>金額（税抜）</th><th style={{ width: 150 }}>税区分</th><th style={{ width: 170 }}>精算方法</th><th style={{ width: 34 }}></th></tr></thead>
    <tbody>{payload.expenses.map((row, i) => <tr key={i}>
      <td><input value={row.name} placeholder="例: 取材交通費" onChange={(e) => setRows("expenses", edit(payload.expenses, i, { name: e.target.value }))} /></td>
      <td><input inputMode="numeric" value={row.amountExTax ?? ""} onChange={(e) => setRows("expenses", edit(payload.expenses, i, { amountExTax: toNum(e.target.value) }))} /></td>
      <td>{taxSelect(row.taxCategory, (v) => setRows("expenses", edit(payload.expenses, i, { taxCategory: v })))}</td>
      <td><select value={row.settlement} onChange={(e) => setRows("expenses", edit(payload.expenses, i, { settlement: e.target.value }))}>
        {["実費精算（領収書）", "定額", "上限あり"].map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
      <td><button type="button" className="link-button" onClick={() => setRows("expenses", drop(payload.expenses, i))}>×</button></td>
    </tr>)}</tbody></table>;

  const feesTable = <table className="cf-table"><thead><tr><th>項目</th><th style={{ width: 120 }}>金額（税抜）</th><th style={{ width: 150 }}>税区分</th><th style={{ width: 170 }}>備考</th><th style={{ width: 34 }}></th></tr></thead>
    <tbody>{payload.fees.map((row, i) => <tr key={i}>
      <td><input value={row.name} placeholder="例: 収入印紙代・振込手数料" onChange={(e) => setRows("fees", edit(payload.fees, i, { name: e.target.value }))} /></td>
      <td><input inputMode="numeric" value={row.amountExTax ?? ""} onChange={(e) => setRows("fees", edit(payload.fees, i, { amountExTax: toNum(e.target.value) }))} /></td>
      <td>{taxSelect(row.taxCategory, (v) => setRows("fees", edit(payload.fees, i, { taxCategory: v })))}</td>
      <td><input value={row.notes} onChange={(e) => setRows("fees", edit(payload.fees, i, { notes: e.target.value }))} /></td>
      <td><button type="button" className="link-button" onClick={() => setRows("fees", drop(payload.fees, i))}>×</button></td>
    </tr>)}</tbody></table>;

  const licenseTable = (key: "licenseIn" | "licenseOut") => {
    const rows = payload[key];
    return <table className="cf-table"><thead><tr><th style={{ width: 190 }}>対象素材</th><th>条件名</th><th style={{ width: 70 }}>料率%</th><th style={{ width: 100 }}>MG</th><th style={{ width: 100 }}>AG</th><th style={{ width: 64 }}>加算G</th><th style={{ width: 230 }}>許諾地域</th><th style={{ width: 190 }}>許諾言語</th><th style={{ width: 34 }}></th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>
        <td>{materialSelect(row.materialCode, (v) => setRows(key, edit(rows, i, { materialCode: v })))}</td>
        <td><input value={row.name} placeholder={key === "licenseIn" ? "例: 原作ロイヤリティ" : "例: 英語版ライセンス"} onChange={(e) => setRows(key, edit(rows, i, { name: e.target.value }))} /></td>
        <td><input inputMode="decimal" value={row.ratePct ?? ""} onChange={(e) => setRows(key, edit(rows, i, { ratePct: toNum(e.target.value) }))} /></td>
        <td><input inputMode="numeric" value={row.mgAmount ?? ""} onChange={(e) => setRows(key, edit(rows, i, { mgAmount: toNum(e.target.value) }))} /></td>
        <td><input inputMode="numeric" value={row.agAmount ?? ""} onChange={(e) => setRows(key, edit(rows, i, { agAmount: toNum(e.target.value) }))} /></td>
        <td><input inputMode="numeric" value={row.groupNo ?? ""} title="同じ番号の行はΣが適用料率（加算型）" onChange={(e) => setRows(key, edit(rows, i, { groupNo: toNum(e.target.value) }))} /></td>
        <td><MultiSelectChips compact value={row.regions} groups={TERRITORY_GROUPS} onChange={(v) => setRows(key, edit(rows, i, { regions: v }))} /></td>
        <td><MultiSelectChips compact value={row.languages} groups={LANGUAGE_GROUPS} onChange={(v) => setRows(key, edit(rows, i, { languages: v }))} /></td>
        <td><button type="button" className="link-button" onClick={() => setRows(key, drop(rows, i))}>×</button></td>
      </tr>)}</tbody></table>;
  };

  const sumsIn = groupRateSums(payload.licenseIn);
  const entryNote: Record<ConditionLedgerPayload["entry"], string> = {
    new: "作品に紐づかない条件。相手先を選んで②へ。あとから作品に紐づけることもできます。",
    work: "作品に紐づく条件。既存作品を検索、または新規作品を登録してから戻ってきます。②では対象素材にその作品の素材が出ます。"
  };

  function stepCard(n: number, heading: string, summary: string, body: ReactNode, state: "current" | "done" | "locked") {
    return <section className={`panel wce-card cf-step ${state}`}>
      <div className="wce-head"><span className="wi-step">{n}</span><h2>{heading}</h2>
        <small>{summary}</small><span className="wi-spacer"></span>
        {state === "done" && <button type="button" onClick={() => setStep(n as 1 | 2 | 3)}>この段階を開く</button>}
        {state === "done" && <span className="wz-tag eff">完了</span>}
      </div>
      {state === "current" && body}
    </section>;
  }

  const stateOf = (n: number): "current" | "done" | "locked" => (n === step ? "current" : n < step ? "done" : "locked");
  const choices = ledgerDocumentChoices(payload, work?.businessLine);

  return <section className="page wce cf">
    <div className="page-title"><div>
      <p>CONDITION LEDGER</p>
      <h1>条件を登録する{ledger ? ` — ${ledger.documentNumber}` : ""}{work ? `／${work.workCode ?? ""} ${work.title}` : ""}</h1>
      <small>入口 → 条件明細の種類を選んで作成（業務委託・利用許諾イン・利用許諾アウトは複数選べる）→ 最後に文書へどう紐づけるかを選ぶ。条件明細は台帳にだけ存在し、文書の確定で作り直さない。</small>
    </div><div className="matter-detail-actions">
      {work && <button type="button" onClick={() => onOpenWork(work.id)}>作品を開く</button>}
      <button type="button" onClick={onBack}>戻る</button>
    </div></div>
    {error && <div className="async-error">{error}</div>}
    {!canWrite && <div className="wd-guide"><strong>この環境では条件台帳の保存が無効です（documents スコープ）。</strong><p>閲覧はできますが保存できません。</p></div>}
    {ledger?.status === "draft" && <div className="cf-draft-band">下書き <b>{ledger.documentNumber}</b>（{ledger.title || "無題"}）。条件明細は台帳に入っていますが、確定するまで計算書の下地には使われません。</div>}

    {stepCard(1, "入口 — 何に紐づく話か", payload.entry === "work" ? `作品: ${work ? `${work.workCode ?? ""} ${work.title}` : "未選択"}` : "作品と関係ない依頼", <>
      <div className="wdl-grid cf-entry">
        <button type="button" className={payload.entry === "new" ? "primary" : ""} onClick={() => update({ entry: "new", workId: null, workCode: null, workTitle: "" })}>
          <b>新規</b><small>作品と関係ない依頼（業務委託・単発の許諾など）。相手先を選んで始める</small></button>
        <button type="button" className={payload.entry === "work" ? "primary" : ""} onClick={() => update({ entry: "work" })}>
          <b>作品</b><small>作品に紐づく条件。新規作品なら作品登録へ、既存作品なら検索</small></button>
        <button type="button" onClick={onOpenTemplates}>
          <b>条件明細なし</b><small>相談・回答、NDA、基本契約、覚書、通知書など。従来の文書作成へ →</small></button>
      </div>
      {payload.entry === "work" && <div className="wi-grid">
        <SearchableLedgerSelect type="works" value={payload.workId != null ? String(payload.workId) : ""} label="既存作品を検索"
          placeholder="作品名・コードで検索…" helper={work ? `${work.workCode ?? ""} ${work.title}／展開: ${businessLineLabel(work.businessLine)}／素材 ${work.materials.length}件` : undefined}
          onChange={(value) => void pickWork(value)} />
        <label>&nbsp;<button type="button" onClick={onRegisterWork}>新規作品を登録してから戻る →</button></label>
      </div>}
      <p className="wz-hint">{entryNote[payload.entry]}</p>
      {drafts.length > 0 && !ledger && <div className="cf-drafts">
        <strong>下書き（続きから）</strong>
        <ul>{drafts.map((d) => <li key={d.id}>
          <b>{d.documentNumber}</b><span>{d.title || "無題"}</span><span>{d.vendorName}</span>
          {d.workCode && <span className="wz-tag">{d.workCode}</span>}
          <small>{d.kinds.map((k) => LEDGER_KIND_OPTIONS.find((o) => o.value === k)?.label ?? k).join("・")}／{d.lineCount}行／{fmtDate(d.updatedAt)}</small>
          <span className="wi-spacer"></span>
          <button type="button" className="primary" onClick={() => void resume(d.id)}>続きから</button>
        </li>)}</ul>
      </div>}
      <div className="wz-next">
        <button type="button" className="primary" disabled={payload.entry === "work" && !payload.workId} onClick={() => { setError(""); setStep(2); }}>次へ：条件明細の種類を選ぶ</button>
        {payload.entry === "work" && !payload.workId && <small>作品を選ぶか、新規作品を登録してください</small>}
      </div>
    </>, stateOf(1))}

    {stepCard(2, "条件明細を選んで作成", `${payload.vendorName || "相手先未選択"}／${payload.kinds.map((k) => LEDGER_KIND_OPTIONS.find((o) => o.value === k)?.label ?? k).join("・") || "種類未選択"}／${rowCount}行`, <>
      <div className="wi-grid">
        <SearchableLedgerSelect type="vendors" value={payload.vendorId != null ? String(payload.vendorId) : ""} label="相手先（取引先マスタ）*"
          placeholder="名称・コードで検索…" helper={payload.vendorName ? `現在: ${payload.vendorName}` : undefined}
          onChange={(value, item) => update({ vendorId: value ? Number(value) : null, vendorName: item?.title ?? (value ? payload.vendorName : "") })} />
        <label>契約名（台帳の件名）<input value={payload.title} maxLength={300} placeholder="例: 「エピローグ」イラスト制作・原作許諾" onChange={(e) => update({ title: e.target.value })} /></label>
        <label>適用期間（開始）<input type="date" value={payload.termStart} onChange={(e) => update({ termStart: e.target.value })} /></label>
        <label>適用期間（終了）<input type="date" value={payload.termEnd} onChange={(e) => update({ termEnd: e.target.value })} /></label>
      </div>
      <div className="cf-kinds">
        {LEDGER_KIND_OPTIONS.map((o) => <label key={o.value} className={`cf-kind ${o.value} ${hasKind(o.value) ? "on" : ""}`}>
          <input type="checkbox" checked={hasKind(o.value)} onChange={(e) => update({ kinds: e.target.checked ? [...payload.kinds, o.value] : payload.kinds.filter((k) => k !== o.value) })} />
          <b>{o.label}</b><small>{o.hint}</small>
        </label>)}
      </div>

      {hasKind("service") && <div className="cf-block svc">
        <h3><span className="wz-tag svc">業務委託</span>支払・経費・手数料 <small>発注書の明細・経費・その他手数料に引用。課税区分は経理提出用エクセルへ</small></h3>
        <h4>支払（成果物）</h4>
        {paymentsTable}
        <div><button type="button" className="small" onClick={() => setRows("payments", [...payload.payments, emptyPaymentRow()])}>＋ 支払行</button></div>
        <h4>経費（実費精算）</h4>
        {expensesTable}
        <div><button type="button" className="small" onClick={() => setRows("expenses", [...payload.expenses, emptyExpenseRow()])}>＋ 経費行</button></div>
        <h4>その他手数料</h4>
        {feesTable}
        <div><button type="button" className="small" onClick={() => setRows("fees", [...payload.fees, emptyFeeRow()])}>＋ 手数料行</button></div>
        <div className="cf-taxbox">
          <div>課税対象（10%）<b>{yen(tax.taxable)}</b></div><div>課税対象（8%）<b>{yen(tax.reduced)}</b></div>
          <div>非課税・不課税<b>{yen(tax.exempt)}</b></div><div>消費税<b>{yen(tax.tax)}</b></div><div>合計（税込）<b>{yen(tax.total)}</b></div>
        </div>
        <p className="wz-hint">課税対象と非課税（立替・印紙等）を分けて持つので、発注書の税計算と経理提出用エクセル（課税／非課税列）が条件明細から直接出ます。</p>
      </div>}

      {hasKind("license_in") && <div className="cf-block lic-in">
        <h3><span className="wz-tag eff">利用許諾 イン</span>当社が支払う料率 <small>個別条件書（ゲーム／出版）に展開。計算書の下地</small></h3>
        {licenseTable("licenseIn")}
        <div className="wz-next" style={{ margin: 0 }}>
          <button type="button" className="small" onClick={() => setRows("licenseIn", [...payload.licenseIn, emptyLicenseRow()])}>＋ 料率行</button>
          {Object.keys(sumsIn).map((g) => <small key={g}>加算G{g} 適用料率 Σ{sumsIn[g].toFixed(1)}%</small>)}
        </div>
      </div>}

      {hasKind("license_out") && <div className="cf-block lic-out">
        <h3><span className="wz-tag out">利用許諾 アウト</span>当社が受け取る料率 <small>ライセンスアウト契約（英文）に展開。計算書（受取）の下地</small></h3>
        {licenseTable("licenseOut")}
        <div><button type="button" className="small" onClick={() => setRows("licenseOut", [...payload.licenseOut, emptyLicenseRow()])}>＋ 料率行</button></div>
      </div>}

      <div className="wz-next">
        <button type="button" className="primary" disabled={saving || !canWrite} onClick={() => void save("final").then((d) => { if (d) setStep(3); })}>
          {saving ? "保存中…" : "条件明細を保存して、文書の扱いへ"}</button>
        <button type="button" disabled={saving || !canWrite} onClick={() => void save("draft")}>一時保存（下書き）</button>
        <button type="button" onClick={() => setStep(1)}>入口に戻る</button>
        <small>保存で台帳へ登録（作品の条件・料率に即反映）。文書はまだ作らない{dirty && ledger ? "／未保存の変更があります" : ""}</small>
      </div>
    </>, stateOf(2))}

    {stepCard(3, "最後に、どの文書にするか", ledger ? `${ledger.documentNumber}／紐づく文書 ${ledger.linkedDocuments.length}件` : "", ledger ? <>
      <div className="wdl-grid cf-entry">
        <button type="button" className={attachMode === "new" ? "primary" : ""} onClick={() => setAttachMode("new")}>
          <b>新規文書に紐づける（発行）</b><small>条件を反映した状態で従来の文書作成フォームを開き、そのまま作成・確定</small></button>
        <button type="button" className={attachMode === "past" ? "primary" : ""} onClick={() => setAttachMode("past")}>
          <b>過去文書に紐づける</b><small>取込済み・確定済みの文書を検索して条件明細を紐づける</small></button>
        <button type="button" className={attachMode === "upload" ? "primary" : ""} onClick={() => setAttachMode("upload")}>
          <b>アップロード文書に紐づける</b><small>締結済みの契約書PDFを上げて、その文書に条件明細を紐づける</small></button>
      </div>

      {attachMode === "new" && <>
        <p className="wz-hint">②で選んだ種類から作れる文書だけが有効（グレーは理由つき）。文書作成フォームでは条件が引用済みで、確定時は台帳へ文書番号を紐づけるだけ＝条件明細は二重になりません。</p>
        <div className="wdl-grid">
          {choices.map((c) => <button type="button" key={c.templateKey} disabled={!!c.blockedReason} className={c.blockedReason ? "" : "primary"}
            onClick={() => { const h = handoff(); if (h) onCreateDocument(c.templateKey, payload, h); }}>
            <b>{c.label}</b><small>{c.blockedReason ? `作れません: ${c.blockedReason}` : c.hint}</small></button>)}
        </div>
      </>}
      {attachMode === "past" && <div className="wce-two">
        <div><strong>システム内の文書を検索して紐づける</strong>
          <DocQuotePicker note="確定済み文書・取込済みの過去文書を検索。選ぶと即紐づけます" quoteNumber="" onPick={(hit) => { if (hit) void attachDocument(hit.id, hit.documentNumber); }} /></div>
      </div>}
      {attachMode === "upload" && <div className="wce-two"><div>
        <strong>契約書・発注書をアップロードして紐づける</strong>
        <input ref={fileInput} type="file" style={{ display: "none" }} onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)} />
        <div className="wz-next" style={{ margin: 0 }}>
          <button type="button" onClick={() => fileInput.current?.click()}>ファイルを選択</button>
          <small>{pendingFile ? pendingFile.name : "PDF等・30MBまで"}</small>
        </div>
        {pendingFile && <div className="wi-grid" style={{ padding: "8px 0 0" }}>
          <label>種別<select value={uploadMeta.templateType} onChange={(e) => setUploadMeta({ ...uploadMeta, templateType: e.target.value })}>
            {INTAKE_DOC_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
          <label>文書番号 *<input value={uploadMeta.docNumber} onChange={(e) => setUploadMeta({ ...uploadMeta, docNumber: e.target.value })} placeholder="例: LIC-2024-0012" /></label>
          <label>締結日<input type="date" value={uploadMeta.date} onChange={(e) => setUploadMeta({ ...uploadMeta, date: e.target.value })} /></label>
          <div className="wz-next" style={{ margin: 0 }}><button type="button" className="primary" disabled={saving} onClick={() => void upload()}>アップロードして紐づける</button></div>
        </div>}
      </div></div>}

      <div className="cf-linked">
        <strong>この条件台帳に紐づく文書</strong>
        {ledger.linkedDocuments.length === 0 && <p className="wz-hint">まだありません。上の3択のいずれかで紐づけてください（あとからでも可）。</p>}
        {ledger.linkedDocuments.length > 0 && <ul className="wce-docs">{ledger.linkedDocuments.map((d) => <li key={d.id}>
          <b>{d.documentNumber ?? `#${d.id}`}</b><span>{DOC_KIND_LABELS[d.templateType ?? ""] ?? d.templateType ?? "—"}</span>
          <span className="wz-doctitle">{d.title ?? ""}</span>
          {d.lifecycleStatus === "voided" && <span className="wz-tag">無効化</span>}
          <span className="wi-spacer"></span>
          <button type="button" className="link-button" onClick={() => void detachDocument(d)}>紐づけ解除</button>
        </li>)}</ul>}
      </div>
      <div className="wz-next">
        <button type="button" className="primary" onClick={() => (work ? onOpenWork(work.id) : onBack())}>完了（{work ? "作品を開く" : "戻る"}）</button>
        <button type="button" onClick={() => setStep(2)}>条件明細を直す</button>
        <small>検収書・利用許諾料計算書は時間差で依頼が来るため、ここでは作りません。あとで「後続文書」から契約 {ledger.documentNumber} を呼び出して作ります。</small>
      </div>
    </> : <p className="wz-hint">②で条件明細を保存すると開きます。</p>, stateOf(3))}
  </section>;
}
