import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudSignSourceError, looksLikePdf, resolveCloudSignSourcePdf
} from "./cloudsign-source-pdf.js";
import { driveFileIdFromLink, MemoryDriveStorage } from "./drive-storage.js";
import type { RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { DocumentFormSchema } from "../../types.js";

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

function document(overrides: Partial<RegisteredDocument> = {}): RegisteredDocument {
  return {
    id: 10, documentNumber: "ATT-2026-00001", issueKey: "LEGAL-1",
    templateType: "counterparty_draft", templateVersionId: null,
    title: "先方契約書", counterparty: "取引先", driveLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
    createdAt: "2026-08-17T00:00:00.000Z", createdBy: "u@example.com",
    formData: { original_file_name: "契約書.pdf", source_mime_type: "application/pdf" },
    ...overrides
  };
}

// テンプレートを持つ文書だけ findCurrent が返る、という本番の形をなぞる。
function templates(withTemplate: string[] = []): TemplateRepository {
  return {
    list: async () => [],
    findPartials: async () => ({}),
    findRenderSource: async (key: string) => withTemplate.includes(key)
      ? { templateVersionId: 1, htmlSource: "<p>{{title}}</p>" } : null,
    findCurrent: async (key: string) => withTemplate.includes(key)
      ? { templateKey: key, label: key, templateVersionId: 1, fields: [] } as DocumentFormSchema : null
  };
}

const pdfRenderer = { render: async (html: string) => Buffer.from(`rendered:${html}`) };

test("Drive リンクからファイルIDを取り出す", () => {
  assert.equal(driveFileIdFromLink(`https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`), FILE_ID);
  assert.equal(driveFileIdFromLink(`https://drive.google.com/open?id=${FILE_ID}`), FILE_ID);
  assert.equal(driveFileIdFromLink(`https://docs.google.com/document/d/${FILE_ID}/edit`), FILE_ID);
  assert.equal(driveFileIdFromLink(FILE_ID), FILE_ID);
  assert.equal(driveFileIdFromLink(""), null);
  assert.equal(driveFileIdFromLink(null), null);
  assert.equal(driveFileIdFromLink("https://example.com/no-id"), null);
});

test("PDF判定は記録したMIMEを優先し、無ければ拡張子で見る", () => {
  assert.equal(looksLikePdf(document()), true);
  assert.equal(looksLikePdf(document({
    formData: { source_mime_type: "application/msword", original_file_name: "契約書.pdf" }
  })), false, "MIMEがあれば拡張子に釣られない");
  assert.equal(looksLikePdf(document({
    formData: { original_file_name: "契約書.pdf" }
  })), true);
  assert.equal(looksLikePdf(document({
    formData: { original_file_name: "契約書.docx" }
  })), false);
});

test("テンプレートがある文書は従来どおり描画する（Driveは触らない）", async () => {
  const drive = new MemoryDriveStorage();
  const source = await resolveCloudSignSourcePdf(
    document({ templateType: "purchase_order" }),
    { templates: templates(["purchase_order"]), pdfRenderer, driveStorage: drive });
  assert.equal(source.fromDrive, false);
  assert.match(source.pdf.toString(), /^rendered:/);
  assert.deepEqual(drive.downloads, []);
});

test("テンプレートが無い添付は Drive の実体をそのまま送る", async () => {
  const drive = new MemoryDriveStorage();
  drive.seedFile(FILE_ID, Buffer.from("%PDF-1.7 signed draft"), "application/pdf");
  const source = await resolveCloudSignSourcePdf(
    document(), { templates: templates(), pdfRenderer, driveStorage: drive });
  assert.equal(source.fromDrive, true);
  assert.equal(source.pdf.toString(), "%PDF-1.7 signed draft");
  assert.deepEqual(drive.downloads, [FILE_ID]);
});

test("PDF以外の添付は理由付きで拒否する（CloudSignはPDFのみ）", async () => {
  const drive = new MemoryDriveStorage();
  await assert.rejects(
    () => resolveCloudSignSourcePdf(
      document({ formData: { original_file_name: "契約書.docx", source_mime_type: "application/msword" } }),
      { templates: templates(), pdfRenderer, driveStorage: drive }),
    (error: unknown) => error instanceof CloudSignSourceError &&
      error.code === "CLOUDSIGN_SOURCE_NOT_PDF" && error.status === 422 &&
      error.message.includes("application/msword"));
  assert.deepEqual(drive.downloads, [], "拒否した時点でDriveを読まない");
});

test("添付後に中身が差し替えられていれば送らない", async () => {
  const drive = new MemoryDriveStorage();
  // 記録上は PDF だが、Drive 側は別形式になっている。
  drive.seedFile(FILE_ID, Buffer.from("PK zip"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await assert.rejects(
    () => resolveCloudSignSourcePdf(document(), { templates: templates(), pdfRenderer, driveStorage: drive }),
    (error: unknown) => error instanceof CloudSignSourceError && error.code === "CLOUDSIGN_SOURCE_NOT_PDF");
});

test("Driveリンクが無い文書は404相当で止める", async () => {
  await assert.rejects(
    () => resolveCloudSignSourcePdf(
      document({ driveLink: "" }),
      { templates: templates(), pdfRenderer, driveStorage: new MemoryDriveStorage() }),
    (error: unknown) => error instanceof CloudSignSourceError &&
      error.code === "CLOUDSIGN_SOURCE_NOT_AVAILABLE" && error.status === 404);
});

test("Drive連携が無効なら添付からは依頼できない（503）", async () => {
  await assert.rejects(
    () => resolveCloudSignSourcePdf(document(), { templates: templates(), pdfRenderer }),
    (error: unknown) => error instanceof CloudSignSourceError &&
      error.code === "CLOUDSIGN_DRIVE_UNAVAILABLE" && error.status === 503);
});

test("空ファイルは送らない", async () => {
  const drive = new MemoryDriveStorage();
  drive.seedFile(FILE_ID, Buffer.alloc(0), "application/pdf");
  await assert.rejects(
    () => resolveCloudSignSourcePdf(document(), { templates: templates(), pdfRenderer, driveStorage: drive }),
    (error: unknown) => error instanceof CloudSignSourceError && error.code === "CLOUDSIGN_SOURCE_EMPTY");
});
