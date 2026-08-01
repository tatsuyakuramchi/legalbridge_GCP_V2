import { useEffect, useMemo, useState } from "react";
import type { DocumentFormSchema } from "../types";

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
  selectedId
}: {
  templates: DocumentFormSchema[];
  onCreate: () => void;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
  selectedId?: number;
}) {
  const [query, setQuery] = useState("");
  const [templateType, setTemplateType] = useState("");
  const [documents, setDocuments] = useState<RegisteredDocument[]>([]);
  const [selected, setSelected] = useState<RegisteredDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
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
      <div><p>DOCUMENT REGISTRY</p><h1>文書一覧</h1><small>既存文書を読み取り専用で検索・確認します</small></div>
      <button className="primary" onClick={onCreate}>文書を作成</button>
    </div>
    <div className="registry-toolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="文書番号、案件キー、件名、相手方で検索" />
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
  onRefresh
}: {
  document: RegisteredDocument | null;
  label?: string;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
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
      <dt>案件キー</dt><dd>{document.issueKey}</dd>
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
          {downloadingPdf ? "PDFを生成中…" : "PDFを再生成・ダウンロード"}
        </button>
      )}
      {canSaveToDrive && !document.driveLink && (
        <button className="drive-save-button" onClick={() => void saveToDrive()} disabled={savingDrive}>
          {savingDrive ? "Driveへ保存中…" : "Driveへ保存"}
        </button>
      )}
      {document.driveLink && (
        <a className="drive-link" href={document.driveLink} target="_blank" rel="noreferrer">
          保存文書を開く
        </a>
      )}
    </div>
    {pdfError && <small className="document-output-error">{pdfError}</small>}
    {driveError && <small className="document-output-error">{driveError}</small>}
    {(canGeneratePdf || canSaveToDrive) && (
      <small className="pdf-safety-note">
        PDFは選択した文書から都度再生成します。Drive保存は検証用フォルダに限定され、Backlog・Slack・メールへの送信は行いません。
      </small>
    )}
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
