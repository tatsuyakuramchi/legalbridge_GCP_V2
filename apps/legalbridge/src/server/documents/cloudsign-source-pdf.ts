import type { RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { DriveStorage } from "./drive-storage.js";
import { driveFileIdFromLink } from "./drive-storage.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import { renderStoredDocumentHtml } from "./document-html-renderer.js";

// CloudSign へ送る PDF の調達。文書は2種類ある:
//   1. テンプレートから作った文書 → いつもの描画パイプラインで PDF を生成
//   2. 案件に添付しただけの文書（相手方ドラフト等・ATT-…）→ テンプレートが無いので
//      Drive の実体をそのまま使う。システム外で作った契約書を送る実務のため。
// 2 を許さないと「Drive に文書はあるのにテンプレートが無い」で送信できない。

export class CloudSignSourceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message);
    this.name = "CloudSignSourceError";
  }
}

export interface CloudSignSourcePdf {
  pdf: Buffer;
  // 実体をそのまま使ったか（テンプレート描画ではないか）。監査・UI 表示用。
  fromDrive: boolean;
}

function formValue(document: RegisteredDocument, key: string): string {
  const value = (document.formData ?? {})[key];
  return value == null ? "" : String(value);
}

// 添付の元ファイル名・記録した MIME から PDF かどうかを判定する。
// CloudSign は PDF しか受け付けないので、Word 等はここで止めて理由を返す。
export function looksLikePdf(document: RegisteredDocument): boolean {
  const mime = formValue(document, "source_mime_type").toLowerCase();
  if (mime) return mime === "application/pdf";
  const name = formValue(document, "original_file_name") || document.title;
  return /\.pdf$/i.test(name.trim());
}

export function documentLabel(document: RegisteredDocument): string {
  return document.documentNumber ?? String(document.id);
}

export async function resolveCloudSignSourcePdf(
  document: RegisteredDocument,
  deps: {
    templates: TemplateRepository;
    pdfRenderer: PdfRenderer;
    driveStorage?: DriveStorage;
  }
): Promise<CloudSignSourcePdf> {
  const html = await renderStoredDocumentHtml(deps.templates, document);
  if (html) return { pdf: await deps.pdfRenderer.render(html), fromDrive: false };

  // テンプレートが無い＝添付。Drive の実体を使えるか順に確かめ、
  // 落ちた理由がそのまま操作の手掛かりになるようにする。
  const fileId = driveFileIdFromLink(document.driveLink);
  if (!fileId) {
    throw new CloudSignSourceError(
      "CLOUDSIGN_SOURCE_NOT_AVAILABLE",
      `テンプレートが無く、Drive上のファイルも見つかりません（${documentLabel(document)}）。` +
        "案件に添付し直してから依頼してください。",
      404
    );
  }
  if (!looksLikePdf(document)) {
    const mime = formValue(document, "source_mime_type") || "不明";
    throw new CloudSignSourceError(
      "CLOUDSIGN_SOURCE_NOT_PDF",
      `CloudSignへ送れるのはPDFのみです（${documentLabel(document)}／${mime}）。` +
        "PDFに変換して添付し直してください。"
    );
  }
  if (!deps.driveStorage?.downloadFile) {
    throw new CloudSignSourceError(
      "CLOUDSIGN_DRIVE_UNAVAILABLE",
      "Drive連携が有効でないため、添付ファイルからは依頼できません。",
      503
    );
  }
  const file = await deps.driveStorage.downloadFile(fileId);
  if (!file.data.length) {
    throw new CloudSignSourceError(
      "CLOUDSIGN_SOURCE_EMPTY",
      `Drive上のファイルが空です（${documentLabel(document)}）。`
    );
  }
  // Drive 側の MIME も確認する（添付後に差し替えられている場合を弾く）。
  if (file.mimeType && file.mimeType.toLowerCase() !== "application/pdf") {
    throw new CloudSignSourceError(
      "CLOUDSIGN_SOURCE_NOT_PDF",
      `CloudSignへ送れるのはPDFのみです（${documentLabel(document)}／${file.mimeType}）。`
    );
  }
  return { pdf: file.data, fromDrive: true };
}
