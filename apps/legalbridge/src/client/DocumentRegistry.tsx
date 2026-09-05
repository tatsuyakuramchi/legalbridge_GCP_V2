import { useEffect, useMemo, useState } from "react";
import type { DocumentFormSchema } from "../types";
import { useToast } from "./Toast";
import { DocumentIntegrations } from "./DocumentIntegrations";
import { DocumentConditionAttachment } from "./DocumentConditionAttachment";

type RegisteredDocument = {
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

export function DocumentRegistry({
  templates,
  onCreate,
  canGeneratePdf,
  canSaveToDrive,
  canImport = false,
  canGmailNotify = false,
  canCloudSign = false,
  canAttachConditions = false,
  selectedId,
  initialQuery = ""
}: {
  templates: DocumentFormSchema[];
  onCreate: () => void;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
  canImport?: boolean;
  canGmailNotify?: boolean;
  canCloudSign?: boolean;
  canAttachConditions?: boolean;
  selectedId?: number;
  initialQuery?: string;
}) {
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [templateType, setTemplateType] = useState("");
  const [documents, setDocuments] = useState<RegisteredDocument[]>([]);
  const [selected, setSelected] = useState<RegisteredDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => { if (initialQuery) setQuery(initialQuery); }, [initialQuery]);
  const labels = useMemo(
    () => new Map(templates.map((item) => [item.templateKey, item.label])),
    [templates]
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, limit: "100" });
      if (templateType) params.set("template_type", templateType);
      setLoading(true);
      setError("");
      fetch(`/api/v2/documents?${params}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setDocuments(data.documents ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("文書一覧を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, templateType, reload]);

  async function selectDocument(id: number) {
    setError("");
    const response = await fetch(`/api/v2/documents/${id}`);
    if (!response.ok) { setError("文書詳細を取得できませんでした。"); return; }
    setSelected((await response.json()).document);
  }
  useEffect(() => { if (selectedId) void selectDocument(selectedId); }, [selectedId]);

  return <section className="page registry-page">
    <div className="page-title">
      <div><p>DOCUMENT REGISTRY</p><h1>確定済みの文書</h1><small>確定した文書の内容確認とPDF出力ができます</small></div>
      <div className="matter-detail-actions">
        {canImport && <button onClick={() => setImporting(true)}>過去文書取込</button>}
        <button className="primary" onClick={onCreate}>文書を作成</button>
      </div>
    </div>
    {importing && <PastDocumentImport onClose={() => { setImporting(false); setReload((v) => v + 1); }} />}
    {initialQuery && (
      <div className="deep-link-notice">
        Slackで案内された受付番号 <strong>{initialQuery}</strong> の文書を表示しています。
      </div>
    )}
    <div className="registry-toolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="文書番号、受付番号、件名、相手方で検索" />
      <select value={templateType} onChange={(event) => setTemplateType(event.target.value)}>
        <option value="">すべての文書種別</option>
        {templates.map((item) => <option key={item.templateKey} value={item.templateKey}>{item.label}</option>)}
      </select>
      <span>{loading ? "検索中…" : `${documents.length}件`}</span>
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    <div className="registry-layout">
      <div className="registry-table panel">
        <table>
          <thead><tr><th>文書番号・件名</th><th>種別</th><th>相手方</th><th>作成日</th><th>状態</th></tr></thead>
          <tbody>{documents.map((document) =>
            <tr key={document.id} className={selected?.id === document.id ? "selected" : ""}
              onClick={() => void selectDocument(document.id)}>
              <td><b>{document.documentNumber ?? "未発番"}</b><br /><small>{document.title}</small></td>
              <td>{labels.get(document.templateType) ?? document.templateType}<br /><small>{document.issueKey}</small></td>
              <td>{document.counterparty || "—"}</td>
              <td>{formatDate(document.createdAt)}</td>
              <td>
                <span className={document.lifecycle?.state === "finalized" ? "registry-state complete" : "registry-state pending"}>
                  {document.lifecycle?.label ?? (document.documentNumber ? "確定済み" : "未発番")}
                </span>
              </td>
            </tr>)}</tbody>
        </table>
        {!loading && !documents.length && <div className="empty-state">該当する文書がありません。</div>}
      </div>
      <DocumentDetail
        document={selected}
        label={selected ? labels.get(selected.templateType) : undefined}
        canGeneratePdf={canGeneratePdf}
        canSaveToDrive={canSaveToDrive}
        canGmailNotify={canGmailNotify}
        canCloudSign={canCloudSign}
        canAttachConditions={canAttachConditions}
        onRefresh={() => { if (selected) return selectDocument(selected.id); }}
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
  canAttachConditions = false,
  onRefresh
}: {
  document: RegisteredDocument | null;
  label?: string;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
  canGmailNotify?: boolean;
  canCloudSign?: boolean;
  canAttachConditions?: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const [savingDrive, setSavingDrive] = useState(false);
  const [driveError, setDriveError] = useState("");
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");
  if (!document) return <aside className="panel registry-detail empty-detail">一覧から文書を選択してください。</aside>;
  async function downloadPdf() {
    if (!document || downloadingPdf) return;
    setDownloadingPdf(true);
    setPdfError("");
    try {
      const response = await fetch(`/api/v2/documents/${document.id}/pdf`, {
        headers: { Accept: "application/pdf" }
      });
      if (!response.ok) {
        const message = await response.json()
          .then((body) => body.error as string | undefined)
          .catch(() => undefined);
        throw new Error(message ?? "PDFの生成に失敗しました。");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const download = window.document.createElement("a");
      download.href = objectUrl;
      download.download = `${safeFilename(document.documentNumber ?? `document-${document.id}`)}.pdf`;
      window.document.body.appendChild(download);
      download.click();
      download.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : "PDFの生成に失敗しました。");
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function saveToDrive() {
    if (!document || savingDrive) return;
    setSavingDrive(true);
    setDriveError("");
    try {
      const response = await fetch(`/api/v2/documents/${document.id}/drive`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Driveへの保存に失敗しました。");
      await onRefresh();
      window.open(result.driveLink, "_blank", "noopener,noreferrer");
    } catch (error) {
      setDriveError(error instanceof Error ? error.message : "Driveへの保存に失敗しました。");
    } finally {
      setSavingDrive(false);
    }
  }

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
    </dl>
    <div className="document-output-actions">
      {canGeneratePdf && document.documentNumber && (
        <button
          className="pdf-download-link"
          onClick={() => void downloadPdf()}
          disabled={downloadingPdf}
        >
          {downloadingPdf ? "PDFを生成中…" : "PDFを生成・ダウンロード"}
        </button>
      )}
      {canSaveToDrive && !document.driveLink && (
        <button className="drive-save-button" onClick={() => void saveToDrive()} disabled={savingDrive}>
          {savingDrive ? "Driveへ保存中…" : "Driveへ保存"}
        </button>
      )}
      {document.driveLink && (
        <a className="drive-link" href={document.driveLink} target="_blank" rel="noreferrer">
          Drive上の文書を開く
        </a>
      )}
    </div>
    {pdfError && <small className="document-output-error">{pdfError}</small>}
    {driveError && <small className="document-output-error">{driveError}</small>}
    {canGeneratePdf && (
      <small className="pdf-safety-note">
        PDFは選択した確定済み文書から生成します。
        {canSaveToDrive && " Driveへの保存先は検証用フォルダに限定されます。"}
      </small>
    )}
    {document.documentNumber && (canGmailNotify || canCloudSign) && (
      <DocumentIntegrations documentId={document.id} canGmailNotify={canGmailNotify} canCloudSign={canCloudSign} />
    )}
    <DocumentConditionAttachment documentId={document.id} canAttach={canAttachConditions} />
    <h3>登録項目</h3>
    <dl className="form-data-list">
      {entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
    </dl>
  </aside>;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}


function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
}

const DOC_HEADER_MAP: Record<string, string> = {
  "文書番号": "documentNumber", document_number: "documentNumber", documentnumber: "documentNumber", number: "documentNumber",
  "テンプレート種別": "templateType", template_type: "templateType", templatetype: "templateType", "種別": "templateType", template: "templateType",
  "課題キー": "issueKey", issue_key: "issueKey", issuekey: "issueKey", "backlog": "issueKey",
  "driveリンク": "driveLink", drive_link: "driveLink", drivelink: "driveLink", "drive": "driveLink", url: "driveLink",
  "案件id": "matterId", matter_id: "matterId", matterid: "matterId"
};

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
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ insertedCount: number; failedCount: number; failed: Array<{ index: number; error: string }> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const parsed = parseDocCsv(text);
  const valid = parsed.rows.filter((r) => (r.documentNumber ?? "").trim() && (r.templateType ?? "").trim());

  async function submit() {
    if (!valid.length) { setError("取込む文書がありません（文書番号とテンプレート種別が必要です）。"); return; }
    setSaving(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/v2/documents/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: valid })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 422 && response.status !== 201) {
        setError(data.error ?? "取込に失敗しました。"); setSaving(false); return;
      }
      setResult(data);
      toast.push(`${data.insertedCount}件を取込みました${data.failedCount ? `（${data.failedCount}件失敗）` : ""}`,
        data.failedCount ? "info" : "success");
    } catch {
      setError("通信に失敗しました。");
    } finally { setSaving(false); }
  }

  return <div className="panel past-doc-import">
    <div className="matter-detail-head"><div><span className="detail-kicker">IMPORT PAST DOCUMENTS</span><h2>過去文書取込</h2></div>
      <button onClick={onClose}>閉じる</button></div>
    <p className="hub-note">既存の文書番号を持つ過去文書を、文書番号・テンプレート種別・課題キー・Driveリンクで一括登録します（生成は行いません）。1行目にヘッダ。文書番号とテンプレート種別は必須。テンプレート版・本文は空で登録されます。</p>
    {error && <div className="async-error">{error}</div>}
    <textarea rows={7} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }}
      placeholder={"文書番号,テンプレート種別,課題キー,Driveリンク\nPO-2024-0001,purchase_order,LEGAL-12,https://drive.google.com/..."} />
    {parsed.rows.length > 0 && <p className="import-preview-note">
      解析 {parsed.rows.length}行 / 登録対象 {valid.length}行
      {parsed.unmapped.length > 0 && `・未対応列: ${parsed.unmapped.join(", ")}`}
    </p>}
    {valid.length > 0 && <div className="condition-table-wrap"><table className="condition-table">
      <thead><tr><th>文書番号</th><th>種別</th><th>課題</th></tr></thead>
      <tbody>{valid.slice(0, 20).map((r, i) => <tr key={i}>
        <td><b>{r.documentNumber}</b></td><td>{r.templateType}</td><td>{r.issueKey || "—"}</td>
      </tr>)}</tbody></table>{valid.length > 20 && <p className="import-preview-note">ほか {valid.length - 20}行…</p>}</div>}
    {result && <div className="import-result">
      <strong>{result.insertedCount}件 取込完了</strong>{result.failedCount > 0 && <span>・{result.failedCount}件 失敗</span>}
      {result.failed.slice(0, 10).map((f) => <small key={f.index}>行{f.index + 2}: {f.error}</small>)}
    </div>}
    <div className="matter-form-actions">
      <button className="primary" disabled={saving || !valid.length} onClick={submit}>{saving ? "取込中…" : `${valid.length}件を取込`}</button>
    </div>
  </div>;
}
