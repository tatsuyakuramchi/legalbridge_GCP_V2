import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { DocumentFormData, DocumentFormSchema } from "../types";
import { SpecializedDocumentForms } from "./SpecializedDocumentForms";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { DocumentOutputActions } from "./DocumentOutputActions";
import { ExportButtons } from "./ExportButtons";
import { download, type ExportColumn } from "./export-util";

export type RegisteredDocument = {
  id: number;
  documentNumber: string | null;
  issueKey: string;
  templateType: string;
  templateVersionId: number | null;
  title: string;
  counterparty: string;
  driveLink: string;
  createdAt: string;
  createdBy: string | null;
  lifecycleStatus?: string;
  matterId?: number | null;
  formData?: Record<string, unknown>;
  lifecycle?: {
    state: "finalized" | "registered";
    label: string;
    pdfState: "ready" | "unavailable";
    pdfLabel: string;
    driveState: "stored" | "not_stored";
    driveLabel: string;
  };
};

// 通常一覧（{documents}）と PDF未生成キュー（{rows}）のレスポンスを表の行形へ正規化する。
function normalizeRows(data: any, pdfQueue: boolean): RegisteredDocument[] {
  if (pdfQueue) {
    return (data.rows ?? []).map((r: any) => ({
      id: r.id, documentNumber: r.documentNumber ?? null, issueKey: r.issueKey,
      templateType: r.templateType, templateVersionId: null,
      title: r.title ?? "", counterparty: r.counterparty ?? "", driveLink: "",
      createdAt: r.createdAt ?? "", createdBy: null, lifecycleStatus: "final"
    }));
  }
  return data.documents ?? [];
}

const documentExportColumns: ExportColumn<RegisteredDocument>[] = [
  { header: "文書番号", value: (d) => d.documentNumber ?? "" },
  { header: "受付番号", value: (d) => d.issueKey },
  { header: "文書種別", value: (d) => d.templateType },
  { header: "件名", value: (d) => d.title },
  { header: "取引先", value: (d) => d.counterparty },
  { header: "状態", value: (d) => d.lifecycle?.label ?? "" },
  { header: "PDF", value: (d) => d.lifecycle?.pdfLabel ?? "" },
  { header: "Drive", value: (d) => d.lifecycle?.driveLabel ?? "" },
  { header: "作成日時", value: (d) => d.createdAt },
  { header: "作成者", value: (d) => d.createdBy ?? "" }
];

export function DocumentRegistry({
  templates,
  onCreate,
  canGeneratePdf,
  canSaveToDrive,
  canImport = false,
  canGmailNotify = false,
  canCloudSign = false,
  canVoidDocument = false,
  canReissueDocument = false,
  selectedId,
  initialQuery = "",
  onOpenMatter,
  onDuplicate,
  onEditReissue
}: {
  templates: DocumentFormSchema[];
  onCreate: () => void;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
  canImport?: boolean;
  canGmailNotify?: boolean;
  canCloudSign?: boolean;
  canVoidDocument?: boolean;
  canReissueDocument?: boolean;
  selectedId?: number;
  initialQuery?: string;
  onOpenMatter?: (matterId: number) => void;
  // 確定済み文書を下敷きに次を作る。"vendor"=同じ内容を別の相手先へ、
  // "content"=同じ相手先へ別の内容を。
  onDuplicate?: (document: RegisteredDocument, mode: "vendor" | "content") => void;
  // 確定済み文書の特例編集（編集→再発行で枝番 -R<n> を採番）。
  onEditReissue?: (document: RegisteredDocument) => void;
}) {
  const [importing, setImporting] = useState(false);
  // 取込文書（template_version_id 無し）の詳細編集パネル。
  const [editingDetails, setEditingDetails] = useState<RegisteredDocument | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [templateType, setTemplateType] = useState("");
  const [lifecycle, setLifecycle] = useState<"all" | "active" | "voided">("all");
  const [pdfQueue, setPdfQueue] = useState(false);
  const [documents, setDocuments] = useState<RegisteredDocument[]>([]);
  const [selected, setSelected] = useState<RegisteredDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const toast = useToast();
  useEffect(() => { if (initialQuery) setQuery(initialQuery); }, [initialQuery]);
  const labels = useMemo(
    () => new Map(templates.map((item) => [item.templateKey, item.label])),
    [templates]
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      // PDF未生成キュー（10-6 pending-pdf）と通常一覧（状態フィルタ付き）を切り替える。
      const url = pdfQueue
        ? `/api/v2/documents/pending-pdf?${new URLSearchParams(templateType ? { template_type: templateType, limit: "200" } : { limit: "200" })}`
        : `/api/v2/documents?${new URLSearchParams({ q: query, limit: "100", lifecycle, ...(templateType ? { template_type: templateType } : {}) })}`;
      fetch(url, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => { setDocuments(normalizeRows(data, pdfQueue)); setSelectedIds(new Set()); })
        .catch((cause) => { if (cause?.name !== "AbortError") setError("文書一覧を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, templateType, lifecycle, pdfQueue, reload]);

  async function selectDocument(id: number) {
    setError("");
    const response = await fetch(`/api/v2/documents/${id}`);
    if (!response.ok) { setError("文書詳細を取得できませんでした。"); return; }
    setSelected((await response.json()).document);
  }
  useEffect(() => { if (selectedId) void selectDocument(selectedId); }, [selectedId]);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const selectableIds = documents.filter((d) => d.lifecycleStatus !== "voided").map((d) => d.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(selectableIds));
  }
  async function runBulkVoid(reason: string) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const response = await fetch("/api/v2/documents/void-bulk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, confirmation: "COMMIT_DOCUMENT_VOID", reason: reason.trim() || undefined })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { toast.push(data.error ?? "一括無効化に失敗しました。", "error"); return; }
    toast.push(`一括無効化：${data.voided}件を無効化（既:${data.already} 未検出:${data.notFound} 失敗:${data.failed}）`,
      data.failed ? "info" : "success");
    setSelectedIds(new Set());
    setReload((v) => v + 1);
    if (selected && ids.includes(selected.id)) void selectDocument(selected.id);
  }

  return <section className="page registry-page">
    <div className="page-title">
      <div><p>DOCUMENT REGISTRY</p><h1>確定済みの文書</h1><small>確定した文書の内容確認とPDF出力ができます</small></div>
      <div className="matter-detail-actions">
        <ExportButtons filename="documents" sheetName="文書一覧" columns={documentExportColumns} rows={documents} />
        {canImport && <button onClick={() => setImporting(true)}>過去文書取込</button>}
        <button className="primary" onClick={onCreate}>文書を作成</button>
      </div>
    </div>
    {importing && <PastDocumentImport onClose={() => { setImporting(false); setReload((v) => v + 1); }} />}
    {editingDetails && <ImportedDetailsEditor document={editingDetails}
      onClose={() => setEditingDetails(null)}
      onSaved={() => { setEditingDetails(null); setReload((v) => v + 1); void selectDocument(editingDetails.id); }} />}
    {initialQuery && (
      <div className="deep-link-notice">
        Slackで案内された受付番号 <strong>{initialQuery}</strong> の文書を表示しています。
      </div>
    )}
    <div className="registry-toolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="文書番号、受付番号、件名、相手方で検索" disabled={pdfQueue} />
      <select value={templateType} onChange={(event) => setTemplateType(event.target.value)}>
        <option value="">すべての文書種別</option>
        {templates.map((item) => <option key={item.templateKey} value={item.templateKey}>{item.label}</option>)}
      </select>
      <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as typeof lifecycle)} disabled={pdfQueue}>
        <option value="all">すべての状態</option>
        <option value="active">有効のみ（旧版・無効化を除く）</option>
        <option value="voided">無効化のみ</option>
      </select>
      <button className={pdfQueue ? "primary" : ""} onClick={() => { setPdfQueue((v) => !v); setSelected(null); }}
        title="Drive未保存の発行済み文書（PDF出力待ち）だけを表示します">
        {pdfQueue ? "通常一覧へ戻る" : "PDF未生成のみ"}
      </button>
      <span>{loading ? "検索中…" : `${documents.length}件`}</span>
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    {canVoidDocument && selectedIds.size > 0 &&
      <BulkVoidBar count={selectedIds.size} onCancel={() => setSelectedIds(new Set())} onRun={runBulkVoid} />}
    <div className="registry-layout">
      <div className="registry-table panel">
        <table>
          <thead><tr>
            {canVoidDocument && <th className="select-col">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                title="表示中の有効な文書をすべて選択" aria-label="すべて選択" />
            </th>}
            <th>文書番号・件名</th><th>種別</th><th>相手方</th><th>作成日</th><th>状態</th>
          </tr></thead>
          <tbody>{documents.map((document) =>
            <tr key={document.id} className={selected?.id === document.id ? "selected" : ""}
              onClick={() => void selectDocument(document.id)}>
              {canVoidDocument && <td className="select-col" onClick={(e) => e.stopPropagation()}>
                {document.lifecycleStatus !== "voided" &&
                  <input type="checkbox" checked={selectedIds.has(document.id)}
                    onChange={() => toggleSelect(document.id)} aria-label={`選択 ${document.documentNumber ?? document.id}`} />}
              </td>}
              <td><b>{document.documentNumber ?? "未発番"}</b><br /><small>{document.title}</small></td>
              <td>{labels.get(document.templateType) ?? document.templateType}<br /><small>{document.issueKey}</small></td>
              <td>{document.counterparty || "—"}</td>
              <td>{formatDate(document.createdAt)}</td>
              <td>
                {document.lifecycleStatus === "voided"
                  ? <span className="registry-state voided">無効化</span>
                  : <span className={document.lifecycle?.state === "finalized" ? "registry-state complete" : "registry-state pending"}>
                      {document.lifecycle?.label ?? (document.documentNumber ? "確定済み" : "未発番")}
                    </span>}
              </td>
            </tr>)}</tbody>
        </table>
        {!loading && !documents.length && <EmptyState compact icon="▤" title="該当する文書がありません" description="検索条件を変えるか、新規に文書を作成してください。" />}
      </div>
      <DocumentDetail
        document={selected}
        label={selected ? labels.get(selected.templateType) : undefined}
        canGeneratePdf={canGeneratePdf}
        canSaveToDrive={canSaveToDrive}
        canGmailNotify={canGmailNotify}
        canCloudSign={canCloudSign}
        canVoidDocument={canVoidDocument}
        canReissueDocument={canReissueDocument}
        onRefresh={() => { if (selected) return selectDocument(selected.id); }}
        onVoided={() => { setReload((v) => v + 1); if (selected) return selectDocument(selected.id); }}
        onReissued={(newId) => { setReload((v) => v + 1); return selectDocument(newId); }}
        onSelectVersion={(id) => void selectDocument(id)}
        onOpenMatter={onOpenMatter}
        onDuplicate={onDuplicate}
        onEditReissue={onEditReissue}
        canEditImported={canImport}
        onEditDetails={(doc) => setEditingDetails(doc)}
      />
    </div>
  </section>;
}

function DocumentDetail({
  document,
  label,
  canGeneratePdf,
  canSaveToDrive,
  canGmailNotify = false,
  canCloudSign = false,
  canVoidDocument = false,
  canReissueDocument = false,
  onRefresh,
  onVoided,
  onReissued,
  onSelectVersion,
  onOpenMatter,
  onDuplicate,
  onEditReissue,
  canEditImported = false,
  onEditDetails
}: {
  document: RegisteredDocument | null;
  label?: string;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
  canGmailNotify?: boolean;
  canCloudSign?: boolean;
  canVoidDocument?: boolean;
  canReissueDocument?: boolean;
  onRefresh: () => Promise<void> | void;
  onOpenMatter?: (matterId: number) => void;
  onDuplicate?: (document: RegisteredDocument, mode: "vendor" | "content") => void;
  onEditReissue?: (document: RegisteredDocument) => void;
  onVoided?: () => Promise<void> | void;
  onReissued?: (newId: number) => Promise<void> | void;
  onSelectVersion?: (id: number) => void;
  // 取込文書（テンプレート版なし）の詳細編集。admin/legal のみ。
  canEditImported?: boolean;
  onEditDetails?: (document: RegisteredDocument) => void;
}) {
  if (!document) return <aside className="panel registry-detail empty-detail">一覧から文書を選択してください。</aside>;
  const isVoided = document.lifecycleStatus === "voided";
  const entries = Object.entries(document.formData ?? {})
    .filter(([, value]) => value !== null && value !== "" && typeof value !== "object")
    .slice(0, 40);
  return <aside className="panel registry-detail">
    <span className="detail-kicker">DOCUMENT DETAIL</span>
    <h2>{document.documentNumber ?? "未発番"}</h2>
    <p className="detail-title">{document.title}</p>
    <div className="document-lifecycle">
      <span className={document.lifecycle?.state === "finalized" ? "complete" : "pending"}>
        {document.lifecycle?.label ?? (document.documentNumber ? "確定済み" : "登録済み・未発番")}
      </span>
      <span className={document.lifecycle?.pdfState === "ready" ? "complete" : "pending"}>
        {document.lifecycle?.pdfLabel ?? (document.documentNumber ? "PDF生成可能" : "発番後にPDF生成可能")}
      </span>
      <span className={document.lifecycle?.driveState === "stored" ? "complete" : "pending"}>
        {document.lifecycle?.driveLabel ?? (document.driveLink ? "Drive保存済み" : "Drive未保存")}
      </span>
    </div>
    <dl>
      <dt>種別</dt><dd>{label ?? document.templateType}</dd>
      <dt>受付番号</dt><dd>{document.issueKey}</dd>
      <dt>作成日時</dt><dd>{formatDate(document.createdAt)}</dd>
      <dt>作成者</dt><dd>{document.createdBy ?? "—"}</dd>
      <dt>案件</dt><dd>{document.matterId != null && onOpenMatter
        ? <button type="button" className="link-button" onClick={() => onOpenMatter(document.matterId!)}>案件を開く（送付記録へ）</button>
        : document.matterId != null ? `#${document.matterId}` : "未紐付け（案件詳細から紐付け可能）"}</dd>
    </dl>
    {isVoided && <div className="void-banner">この文書は無効化（void）済みです。紐づく実績は取消されています。</div>}
    {!isVoided && canEditImported && onEditDetails && document.templateVersionId === null && (
      <div className="duplicate-zone">
        <h3>取込文書の詳細</h3>
        <p className="hub-note">
          過去文書取込で登録された文書です。発注明細・経費・金銭条件・振込先を入力しておくと、
          検収書作成の「親の発注書から引用」や利用許諾料計算書の下敷きに使えます
          （Drive上のPDFはそのまま・変わりません）。
        </p>
        <button type="button" onClick={() => onEditDetails(document)}>詳細を編集</button>
      </div>
    )}
    {!isVoided && onDuplicate && <div className="duplicate-zone">
      <h3>この文書を下敷きに次を作る</h3>
      <p className="hub-note">
        1つの依頼に複数の文書を出すときに使います。どちらも新しい文書番号で採番され、
        元の文書はそのまま有効なまま残ります（訂正したい場合は「再発行」を使ってください）。
      </p>
      <div className="duplicate-actions">
        <button type="button" onClick={() => onDuplicate(document, "vendor")}>
          相手先を変えて作成
          <small>明細・金額・特約を引き継ぐ／相手先・振込先は選び直し</small>
        </button>
        <button type="button" onClick={() => onDuplicate(document, "content")}>
          内容を変えて作成
          <small>相手先・振込先を引き継ぐ／明細・金額は入れ直し</small>
        </button>
      </div>
    </div>}
    {!isVoided && <DocumentOutputActions
      documentId={document.id}
      documentNumber={document.documentNumber}
      matterId={document.matterId ?? null}
      driveLink={document.driveLink || null}
      canGeneratePdf={canGeneratePdf}
      canSaveToDrive={canSaveToDrive}
      canGmailNotify={canGmailNotify}
      canCloudSign={canCloudSign}
      onSaved={onRefresh} />}
    {canReissueDocument && !isVoided && document.documentNumber &&
      <DocumentReissueZone documentId={document.id} documentNumber={document.documentNumber} onReissued={onReissued}
        onEditReissue={onEditReissue ? () => onEditReissue(document) : undefined} />}
    {canVoidDocument && !isVoided &&
      <DocumentVoidZone documentId={document.id} documentNumber={document.documentNumber} onVoided={onVoided} />}
    <VersionHistory documentId={document.id} onSelect={onSelectVersion} />
    <h3>登録項目</h3>
    <dl className="form-data-list">
      {entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
    </dl>
  </aside>;
}

type VersionRow = {
  id: number; documentNumber: string | null; templateType: string;
  lifecycleStatus: string; isPrimary: boolean; supersededBy: string | null; createdAt: string;
};

function VersionHistory({ documentId, onSelect }: { documentId: number; onSelect?: (id: number) => void }) {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  useEffect(() => {
    let active = true;
    fetch(`/api/v2/documents/${documentId}/history`)
      .then((r) => r.ok ? r.json() : { versions: [] })
      .then((d) => { if (active) setVersions(d.versions ?? []); })
      .catch(() => { if (active) setVersions([]); });
    return () => { active = false; };
  }, [documentId]);
  if (versions.length <= 1) return null;   // 系列が1件のみなら履歴は出さない
  return <div className="version-history">
    <h3>バージョン履歴（{versions.length}）</h3>
    <ul className="version-list">
      {versions.map((v) => <li key={v.id} className={v.id === documentId ? "current" : ""}>
        <button onClick={() => { if (v.id !== documentId) onSelect?.(v.id); }} disabled={v.id === documentId}>
          <span className="v-num">{v.documentNumber ?? "未発番"}</span>
          <span className={`registry-state ${v.lifecycleStatus === "voided" ? "voided" : v.isPrimary ? "complete" : "pending"}`}>
            {v.lifecycleStatus === "voided" ? "無効化" : v.isPrimary ? "正本" : "旧版"}
          </span>
        </button>
      </li>)}
    </ul>
  </div>;
}

function BulkVoidBar({ count, onCancel, onRun }: {
  count: number;
  onCancel: () => void;
  onRun: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const CONFIRM = "COMMIT_DOCUMENT_VOID";
  return <div className="bulk-void-bar">
    <span><strong>{count}件</strong> を選択中</span>
    {!open
      ? <>
          <button className="danger" onClick={() => setOpen(true)}>選択を一括無効化</button>
          <button onClick={onCancel}>選択解除</button>
        </>
      : <>
          <span className="hint">選択した文書を無効化し、紐づく有効な実績（消化）を取消して残高を復元します（取り消せません）。</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由（任意）" />
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={CONFIRM} />
          <button className="danger" disabled={busy || confirmText !== CONFIRM}
            onClick={async () => { setBusy(true); try { await onRun(reason); setOpen(false); setConfirmText(""); setReason(""); } finally { setBusy(false); } }}>
            {busy ? "処理中…" : `${count}件を無効化`}
          </button>
          <button onClick={() => { setOpen(false); setConfirmText(""); }}>キャンセル</button>
        </>}
  </div>;
}

function DocumentReissueZone({ documentId, documentNumber, onReissued, onEditReissue }: {
  documentId: number;
  documentNumber: string;
  onReissued?: (newId: number) => Promise<void> | void;
  // 特例編集: 内容を修正してから新版を発行する（作成フォームで編集→「編集内容で再発行」）。
  onEditReissue?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const CONFIRM = "COMMIT_DOCUMENT_REISSUE";

  async function submit() {
    setBusy(true);
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/reissue`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: CONFIRM, reason: reason.trim() || undefined })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "再発行に失敗しました。", "error"); return; }
      toast.push(`再発行しました：${data.newNumber}（旧版の実績 ${data.carriedEvents ?? 0} 件を新版へ引き継ぎ）。`, "success");
      setOpen(false); setReason(""); setConfirmText("");
      if (typeof data.newId === "number") await onReissued?.(data.newId);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusy(false); }
  }

  return <div className="danger-zone">
    <h3>再発行</h3>
    {!open
      ? <div className="reissue-buttons">
          <button onClick={() => setOpen(true)}>この文書を再発行（同じ内容で新版）</button>
          {onEditReissue &&
            <button onClick={onEditReissue}>特例編集して再発行（内容を修正して新版 -R…）</button>}
        </div>
      : <div className="danger-form">
          <p className="hub-note">
            <strong>{documentNumber}</strong> を基に新版（<code>{documentNumber}-R…</code>）を採番して発行します。
            旧版は「再発行済み」となり、旧版に紐づく実績（消化）は新版へ引き継がれます（残高は変わりません）。
            続けるには合言葉 <code>{CONFIRM}</code> を入力してください。
          </p>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由（任意・Backlogへ記録）" />
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={CONFIRM} />
          <div className="matter-form-actions">
            <button onClick={() => { setOpen(false); setConfirmText(""); }}>キャンセル</button>
            <button className="primary" disabled={busy || confirmText !== CONFIRM} onClick={submit}>
              {busy ? "処理中…" : "再発行を実行"}
            </button>
          </div>
        </div>}
  </div>;
}

function DocumentVoidZone({ documentId, documentNumber, onVoided }: {
  documentId: number;
  documentNumber: string | null;
  onVoided?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const CONFIRM = "COMMIT_DOCUMENT_VOID";

  async function submit() {
    setBusy(true);
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/void`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: CONFIRM, reason: reason.trim() || undefined })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "無効化に失敗しました。", "error"); return; }
      toast.push(
        data.alreadyVoided ? "この文書は既に無効化済みです。"
          : `文書を無効化しました（実績 ${data.voidedEvents ?? 0} 件を取消）。`,
        "success");
      setOpen(false); setReason(""); setConfirmText("");
      await onVoided?.();
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusy(false); }
  }

  return <div className="danger-zone">
    <h3>危険な操作</h3>
    {!open
      ? <button className="danger" onClick={() => setOpen(true)}>この文書を無効化（void）</button>
      : <div className="danger-form">
          <p className="hub-note">
            文書 <strong>{documentNumber ?? "(未発番)"}</strong> を無効化します。紐づく有効な実績（消化）を取消して残高を復元します。
            取り消せません。続けるには合言葉 <code>{CONFIRM}</code> を入力してください。
          </p>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由（任意・Backlogへ記録）" />
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={CONFIRM} />
          <div className="matter-form-actions">
            <button onClick={() => { setOpen(false); setConfirmText(""); }}>キャンセル</button>
            <button className="danger" disabled={busy || confirmText !== CONFIRM} onClick={submit}>
              {busy ? "処理中…" : "無効化を実行"}
            </button>
          </div>
        </div>}
  </div>;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}


const DOC_HEADER_MAP: Record<string, string> = {
  "文書番号": "documentNumber", document_number: "documentNumber", documentnumber: "documentNumber", number: "documentNumber",
  "テンプレート種別": "templateType", template_type: "templateType", templatetype: "templateType", "種別": "templateType", template: "templateType",
  "課題キー": "issueKey", issue_key: "issueKey", issuekey: "issueKey", "backlog": "issueKey",
  "driveリンク": "driveLink", drive_link: "driveLink", drivelink: "driveLink", "drive": "driveLink", url: "driveLink",
  "案件id": "matterId", matter_id: "matterId", matterid: "matterId",
  "件名": "title", title: "title",
  "相手先": "counterparty", counterparty: "counterparty", "取引先": "counterparty",
  "日付": "documentDate", document_date: "documentDate", documentdate: "documentDate", date: "documentDate",
  "ファイル名": "fileName", file_name: "fileName", filename: "fileName", "ファイル": "fileName"
};

// フォームの種別候補（datalist・自由入力も可）。過去文書はテンプレが様々なので縛らない。
const IMPORT_TEMPLATE_TYPES = [
  { value: "purchase_order", label: "発注書" },
  { value: "intl_purchase_order", label: "海外発注書" },
  { value: "inspection_certificate", label: "検収書" },
  { value: "royalty_statement", label: "利用許諾料計算書" },
  { value: "individual_license_terms", label: "個別利用許諾条件" },
  { value: "contract", label: "契約書" },
  { value: "nda", label: "秘密保持契約" },
  { value: "reference", label: "参考資料・その他" }
];

const IMPORT_CSV_HEADER = "文書番号,テンプレート種別,件名,相手先,日付,課題キー,Driveリンク,ファイル名";
const IMPORT_CSV_SAMPLE =
  `${IMPORT_CSV_HEADER}\n` +
  "PO-2019-0001,purchase_order,業務委託発注書,株式会社サンプル,2019-03-05,LEGAL-12,,発注書_サンプル社.pdf\n" +
  "CT-2018-0009,contract,取引基本契約書,株式会社サンプル,2018-04-01,,https://drive.google.com/file/d/xxxx/view,\n";

function parseDocCsv(text: string): { rows: Record<string, string>[]; unmapped: string[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return { rows: [], unmapped: [] };
  const rawHeaders = lines[0].split(",").map((h) => h.trim());
  const fields = rawHeaders.map((h) => DOC_HEADER_MAP[h] ?? DOC_HEADER_MAP[h.toLowerCase()] ?? "");
  const unmapped = rawHeaders.filter((_, i) => !fields[i]);
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    fields.forEach((field, i) => { if (field) row[field] = (cells[i] ?? "").trim(); });
    return row;
  });
  return { rows, unmapped };
}

function PastDocumentImport({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  return <div className="panel past-doc-import">
    <div className="matter-detail-head"><div><span className="detail-kicker">IMPORT PAST DOCUMENTS</span><h2>過去文書取込</h2></div>
      <button onClick={onClose}>閉じる</button></div>
    <p className="hub-note">
      既存の文書番号を持つ過去文書を登録します（生成は行いません）。ファイルを添えると
      <b> Drive に格納され、メールのPDF添付・CloudSign送信にそのまま使えます</b>。
      件名・相手先は一覧・検索・メール文面に使われます。
    </p>
    <div style={{ margin: "6px 0" }}>
      <button type="button" className={`matter-chip ${mode === "single" ? "active" : ""}`}
        onClick={() => setMode("single")}>1件ずつ（ファイル添付）</button>
      <button type="button" className={`matter-chip ${mode === "bulk" ? "active" : ""}`}
        onClick={() => setMode("bulk")}>CSV一括（複数ファイル）</button>
    </div>
    {mode === "single" ? <SinglePastDocumentImport /> : <BulkPastDocumentImport />}
  </div>;
}

// ── 1件ずつの取込：フォーム入力＋ファイル選択（→Drive格納）または Driveリンク ──
function SinglePastDocumentImport() {
  const toast = useToast();
  const empty = { documentNumber: "", templateType: "", title: "", counterparty: "",
    documentDate: "", issueKey: "", driveLink: "" };
  const [values, setValues] = useState(empty);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);   // input[type=file] のリセット用
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof empty) => (e: ChangeEvent<HTMLInputElement>) =>
    setValues((prev) => ({ ...prev, [key]: e.target.value }));

  async function submit() {
    setError("");
    if (!values.documentNumber.trim() || !values.templateType.trim()) {
      setError("文書番号とテンプレート種別は必須です。"); return;
    }
    setSaving(true);
    try {
      let response: Response;
      if (file) {
        const form = new FormData();
        form.append("documentNumber", values.documentNumber.trim());
        form.append("templateType", values.templateType.trim());
        form.append("title", values.title.trim());
        form.append("counterparty", values.counterparty.trim());
        form.append("documentDate", values.documentDate.trim());
        form.append("issueKey", values.issueKey.trim());
        form.append("originalName", file.name);
        form.append("file", file);
        response = await fetch("/api/v2/documents/import/upload", { method: "POST", body: form });
      } else {
        response = await fetch("/api/v2/documents/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: [values] })
        });
      }
      const data = await response.json().catch(() => ({}));
      if (file) {
        if (!response.ok) { setError(data.error ?? "取込に失敗しました。"); return; }
        toast.push(`${data.document.documentNumber} を取込みました（Drive格納済み）`, "success");
      } else {
        if (!response.ok || data.failedCount > 0) {
          setError(data.failed?.[0]?.error ?? data.error ?? "取込に失敗しました。"); return;
        }
        toast.push(`${values.documentNumber} を取込みました`, "success");
      }
      setValues(empty); setFile(null); setFileKey((k) => k + 1);
    } catch { setError("通信に失敗しました。"); } finally { setSaving(false); }
  }

  return <div className="past-doc-single">
    {error && <div className="async-error">{error}</div>}
    <div className="field-grid">
      <label><span>文書番号 *</span>
        <input value={values.documentNumber} onChange={set("documentNumber")} placeholder="PO-2019-0001" /></label>
      <label><span>テンプレート種別 *</span>
        <input value={values.templateType} onChange={set("templateType")} list="import-template-types"
          placeholder="purchase_order / contract など" />
        <datalist id="import-template-types">
          {IMPORT_TEMPLATE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </datalist></label>
      <label><span>件名（任意）</span>
        <input value={values.title} onChange={set("title")} placeholder="業務委託発注書" /></label>
      <label><span>相手先（任意）</span>
        <input value={values.counterparty} onChange={set("counterparty")} placeholder="株式会社〇〇" /></label>
      <label><span>日付（締結日・発行日／任意）</span>
        <input type="date" value={values.documentDate} onChange={set("documentDate")} /></label>
      <label><span>課題キー（任意・Backlog課題がある場合のみ）</span>
        <input value={values.issueKey} onChange={set("issueKey")} placeholder="LEGAL-12" /></label>
    </div>
    <label className="past-doc-file"><span>ファイル（選ぶと Drive に格納されます）</span>
      <input key={fileKey} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
    {!file && <label><span>Driveリンク（ファイルを選ばない場合・既に Drive にあるとき）</span>
      <input value={values.driveLink} onChange={set("driveLink")}
        placeholder="https://drive.google.com/file/d/…" /></label>}
    <p className="import-preview-note">
      PDF を添えて取り込むと、その文書はメールのPDF添付・CloudSign送信にそのまま使えます（Word等は格納のみ・送信はリンク案内）。
    </p>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>
        {saving ? "取込中…" : file ? "ファイルを格納して取込" : "取込"}</button>
    </div>
  </div>;
}

// ── 取込文書の詳細編集 ───────────────────────────────────────────
// 過去文書取込で登録した文書（template_version_id 無し）の form_data を後から
// 入力・編集する。発注明細・経費・手数料・金銭条件は文書作成と同じエディタ
// （SpecializedDocumentForms）を使い、検収書の「親の発注書から引用」がそのまま
// 効く形（items / expenses / other_fees / financial_conditions / 振込先キー）で保存する。
// Drive 上の PDF（実体）には触れない＝記録の補完のみ。
function ImportedDetailsEditor({ document: doc, onClose, onSaved }: {
  document: RegisteredDocument;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [formData, setFormData] = useState<DocumentFormData>({ ...(doc.formData ?? {}) } as DocumentFormData);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const onChange = (name: string, value: unknown) => setFormData((prev) => ({ ...prev, [name]: value }));
  const text = (key: string) => String(formData[key] ?? "");
  const field = (key: string, label: string, type: "text" | "date" | "number" = "text", placeholder = "") =>
    <label key={key}><span>{label}</span>
      <input type={type} value={text(key)} placeholder={placeholder}
        onChange={(e) => onChange(key, type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
    </label>;

  async function save() {
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/v2/documents/${doc.id}/import-details`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formData })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "保存に失敗しました。"); return; }
      toast.push(`${doc.documentNumber ?? doc.id} の詳細を保存しました`, "success");
      onSaved();
    } catch { setError("通信に失敗しました。"); } finally { setSaving(false); }
  }

  return <div className="panel past-doc-import">
    <div className="matter-detail-head">
      <div><span className="detail-kicker">EDIT IMPORTED DOCUMENT</span>
        <h2>取込文書の詳細編集 — {doc.documentNumber ?? "未発番"}</h2></div>
      <button onClick={onClose}>閉じる</button>
    </div>
    <p className="hub-note">
      ここで入力した明細・経費・金銭条件・振込先は、<b>検収書作成の「親の発注書から引用」</b>や
      利用許諾料計算書の下敷きに使われます。Drive上のPDF（取り込んだ実ファイル）は変わりません。
    </p>
    {error && <div className="async-error">{error}</div>}
    <div className="field-grid">
      {field("title", "件名")}
      {field("counterparty", "相手先")}
      {field("document_date", "日付（締結日・発行日）", "date")}
      {field("tax_rate", "税率（%）", "number", "10")}
    </div>
    <details className="imported-bank-details">
      <summary>振込先（検収書へ引用されます・任意）</summary>
      <div className="field-grid">
        {field("bank_name", "銀行名")}
        {field("branch_name", "支店名")}
        {field("account_type", "口座種別", "text", "普通 / 当座")}
        {field("account_number", "口座番号")}
        {field("account_holder_kana", "口座名義（カナ）")}
      </div>
    </details>
    <SpecializedDocumentForms templateKey={doc.templateType} formData={formData} onChange={onChange} />
    <div className="matter-form-actions">
      <button onClick={onClose}>キャンセル</button>
      <button className="primary" disabled={saving} onClick={() => void save()}>
        {saving ? "保存中…" : "詳細を保存"}</button>
    </div>
  </div>;
}

// ── CSV一括取込：リンク行は一括登録、ファイル名列がある行は選択ファイルと照合して
//    1件ずつアップロード（進捗表示）。──────────────────────────────
function BulkPastDocumentImport() {
  const toast = useToast();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<Array<{ documentNumber: string; ok: boolean; message: string }>>([]);
  const parsed = parseDocCsv(text);
  const valid = parsed.rows.filter((r) => (r.documentNumber ?? "").trim() && (r.templateType ?? "").trim());
  const fileByName = new Map(files.map((f) => [f.name, f]));
  const withFile = valid.filter((r) => (r.fileName ?? "").trim());
  const missingFiles = withFile.filter((r) => !fileByName.has(r.fileName!.trim()));
  const linkRows = valid.filter((r) => !(r.fileName ?? "").trim());

  async function submit() {
    if (!valid.length) { setError("取込む文書がありません（文書番号とテンプレート種別が必要です）。"); return; }
    if (missingFiles.length) {
      setError(`ファイルが選択されていません: ${missingFiles.slice(0, 5).map((r) => r.fileName).join(", ")}${missingFiles.length > 5 ? " ほか" : ""}`);
      return;
    }
    setSaving(true); setError(""); setResults([]);
    const outcome: Array<{ documentNumber: string; ok: boolean; message: string }> = [];
    try {
      // 1) リンク行（ファイルなし）は一括で登録
      if (linkRows.length) {
        setProgress(`リンク行を登録中…（${linkRows.length}件）`);
        const response = await fetch("/api/v2/documents/import", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: linkRows })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 422) {
          setError(data.error ?? "取込に失敗しました。"); setSaving(false); setProgress(""); return;
        }
        for (const row of data.inserted ?? []) {
          outcome.push({ documentNumber: row.documentNumber, ok: true, message: "登録" });
        }
        for (const row of data.failed ?? []) {
          outcome.push({ documentNumber: String(linkRows[row.index]?.documentNumber ?? "?"), ok: false, message: row.error });
        }
      }
      // 2) ファイル行は1件ずつアップロード（30MB/件・Drive格納）
      for (let i = 0; i < withFile.length; i += 1) {
        const row = withFile[i];
        const attached = fileByName.get(row.fileName!.trim())!;
        setProgress(`ファイルを格納中… ${i + 1}/${withFile.length}（${row.documentNumber}）`);
        const form = new FormData();
        form.append("documentNumber", (row.documentNumber ?? "").trim());
        form.append("templateType", (row.templateType ?? "").trim());
        form.append("title", (row.title ?? "").trim());
        form.append("counterparty", (row.counterparty ?? "").trim());
        form.append("documentDate", (row.documentDate ?? "").trim());
        form.append("issueKey", (row.issueKey ?? "").trim());
        form.append("originalName", attached.name);
        form.append("file", attached);
        try {
          const response = await fetch("/api/v2/documents/import/upload", { method: "POST", body: form });
          const data = await response.json().catch(() => ({}));
          outcome.push(response.ok
            ? { documentNumber: String(row.documentNumber), ok: true, message: "登録＋Drive格納" }
            : { documentNumber: String(row.documentNumber), ok: false, message: data.error ?? "取込に失敗しました" });
        } catch {
          outcome.push({ documentNumber: String(row.documentNumber), ok: false, message: "通信に失敗しました" });
        }
      }
      setResults(outcome);
      const okCount = outcome.filter((r) => r.ok).length;
      const ngCount = outcome.length - okCount;
      toast.push(`${okCount}件を取込みました${ngCount ? `（${ngCount}件失敗）` : ""}`, ngCount ? "info" : "success");
    } finally { setSaving(false); setProgress(""); }
  }

  return <div className="past-doc-bulk">
    <p className="hub-note">
      1行目にヘッダ。<b>必須は文書番号とテンプレート種別だけ</b>（件名・相手先・日付・課題キーは
      空欄可・列ごと省略も可）。<b>ファイル名</b>列に書いた行は、下で選択した
      ファイルと名前で照合して Drive に格納します（それ以外の行は Driveリンクのみで登録）。
      <button type="button" className="link-button"
        onClick={() => download(IMPORT_CSV_SAMPLE, "過去文書取込テンプレート.csv", "text/csv;charset=utf-8")}>
        CSVテンプレートをダウンロード</button>
    </p>
    {error && <div className="async-error">{error}</div>}
    <textarea rows={7} value={text} onChange={(e) => { setText(e.target.value); setResults([]); }}
      placeholder={IMPORT_CSV_SAMPLE} />
    <label className="past-doc-file"><span>ファイル（複数選択可・CSVの「ファイル名」列と照合）</span>
      <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></label>
    {parsed.rows.length > 0 && <p className="import-preview-note">
      解析 {parsed.rows.length}行 / 登録対象 {valid.length}行
      （ファイル格納 {withFile.length}行・リンクのみ {linkRows.length}行）
      {missingFiles.length > 0 && <b>・未選択ファイル {missingFiles.length}件</b>}
      {parsed.unmapped.length > 0 && `・未対応列: ${parsed.unmapped.join(", ")}`}
    </p>}
    {valid.length > 0 && <div className="condition-table-wrap"><table className="condition-table">
      <thead><tr><th>文書番号</th><th>種別</th><th>件名</th><th>相手先</th><th>ファイル</th></tr></thead>
      <tbody>{valid.slice(0, 20).map((r, i) => <tr key={i}>
        <td><b>{r.documentNumber}</b></td><td>{r.templateType}</td>
        <td>{r.title || "—"}</td><td>{r.counterparty || "—"}</td>
        <td>{(r.fileName ?? "").trim()
          ? (fileByName.has(r.fileName!.trim()) ? `✓ ${r.fileName}` : `✗ ${r.fileName}（未選択）`)
          : (r.driveLink ? "リンク" : "—")}</td>
      </tr>)}</tbody></table>{valid.length > 20 && <p className="import-preview-note">ほか {valid.length - 20}行…</p>}</div>}
    {progress && <p className="import-preview-note">{progress}</p>}
    {results.length > 0 && <div className="import-result">
      <strong>{results.filter((r) => r.ok).length}件 取込完了</strong>
      {results.filter((r) => !r.ok).length > 0 && <span>・{results.filter((r) => !r.ok).length}件 失敗</span>}
      {results.filter((r) => !r.ok).slice(0, 10).map((r, i) =>
        <small key={i}>{r.documentNumber}: {r.message}</small>)}
    </div>}
    <div className="matter-form-actions">
      <button className="primary" disabled={saving || !valid.length} onClick={submit}>
        {saving ? "取込中…" : `${valid.length}件を取込`}</button>
    </div>
  </div>;
}
