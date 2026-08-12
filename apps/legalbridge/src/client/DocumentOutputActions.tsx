import { useState } from "react";
import { DocumentIntegrations } from "./DocumentIntegrations";

// 文書の出力アクション（PDF生成・Drive保存・Gmail/CloudSign 送信）をまとめた再利用部品。
// 文書一覧の詳細ペインと、確定直後の結果パネル（作成→出力の1画面化・B1）の双方で使う。
function safeFilename(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

export function DocumentOutputActions({
  documentId,
  documentNumber,
  driveLink: initialDriveLink = null,
  canGeneratePdf,
  canSaveToDrive,
  canGmailNotify = false,
  canCloudSign = false,
  matterId = null,
  onSaved
}: {
  documentId: number;
  documentNumber: string | null;
  driveLink?: string | null;
  canGeneratePdf: boolean;
  canSaveToDrive: boolean;
  canGmailNotify?: boolean;
  matterId?: number | null;
  canCloudSign?: boolean;
  onSaved?: () => Promise<void> | void;
}) {
  const [driveLink, setDriveLink] = useState<string | null>(initialDriveLink);
  const [savingDrive, setSavingDrive] = useState(false);
  const [driveError, setDriveError] = useState("");
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [regenerating, setRegenerating] = useState(false);

  async function downloadPdf() {
    if (downloadingPdf) return;
    setDownloadingPdf(true);
    setPdfError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/pdf`, { headers: { Accept: "application/pdf" } });
      if (!response.ok) {
        const message = await response.json().then((body) => body.error as string | undefined).catch(() => undefined);
        throw new Error(message ?? "PDFの生成に失敗しました。");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const download = window.document.createElement("a");
      download.href = objectUrl;
      download.download = `${safeFilename(documentNumber ?? `document-${documentId}`)}.pdf`;
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
    if (savingDrive) return;
    setSavingDrive(true);
    setDriveError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/drive`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Driveへの保存に失敗しました。");
      setDriveLink(result.driveLink ?? null);
      await onSaved?.();
      if (result.driveLink) window.open(result.driveLink, "_blank", "noopener,noreferrer");
    } catch (error) {
      setDriveError(error instanceof Error ? error.message : "Driveへの保存に失敗しました。");
    } finally {
      setSavingDrive(false);
    }
  }

  async function regeneratePdf() {
    if (regenerating) return;
    setRegenerating(true);
    setDriveError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/drive/regenerate`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "PDFの再生成に失敗しました。");
      setDriveLink(result.driveLink ?? null);
      await onSaved?.();
    } catch (error) {
      setDriveError(error instanceof Error ? error.message : "PDFの再生成に失敗しました。");
    } finally {
      setRegenerating(false);
    }
  }

  return <>
    <div className="document-output-actions">
      {canGeneratePdf && documentNumber && (
        <button className="pdf-download-link" onClick={() => void downloadPdf()} disabled={downloadingPdf}>
          {downloadingPdf ? "PDFを生成中…" : "PDFを生成・ダウンロード"}
        </button>
      )}
      {canSaveToDrive && !driveLink && (
        <button className="drive-save-button" onClick={() => void saveToDrive()} disabled={savingDrive}>
          {savingDrive ? "Driveへ保存中…" : "Driveへ保存"}
        </button>
      )}
      {driveLink && (
        <a className="drive-link" href={driveLink} target="_blank" rel="noreferrer">Drive上の文書を開く</a>
      )}
      {canSaveToDrive && driveLink && (
        <button className="drive-save-button" onClick={() => void regeneratePdf()} disabled={regenerating}
          title="保存済みデータと現行テンプレートからPDFを作り直し、Drive上のファイルを更新します">
          {regenerating ? "再生成中…" : "PDFを再生成（Drive更新）"}
        </button>
      )}
    </div>
    {pdfError && <small className="document-output-error">{pdfError}</small>}
    {driveError && <small className="document-output-error">{driveError}</small>}
    {canGeneratePdf && (
      <small className="pdf-safety-note">
        PDFは確定済み文書から生成します。{canSaveToDrive && " Driveへの保存先は検証用フォルダに限定されます。"}
      </small>
    )}
    {documentNumber && (canGmailNotify || canCloudSign) && (
      <DocumentIntegrations documentId={documentId} canGmailNotify={canGmailNotify} canCloudSign={canCloudSign} matterId={matterId} />
    )}
  </>;
}
