import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFileStorage, localFileIdFromLink } from "./local-file-storage.js";
import { driveFileIdFromLink } from "./drive-storage.js";
import { driveIdFromUrl } from "../matters/communication-service.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lb-local-"));

test("文書の PDF は doc-<id> で置かれ、同じ文書で見つかる", async () => {
  const storage = new LocalFileStorage(tmp());
  assert.equal(await storage.findByDocumentId(12), null);
  const stored = await storage.uploadPdf({ documentId: 12, filename: "PO-1.pdf", pdf: Buffer.from("%PDF-1") });
  assert.equal(stored.id, "doc-12");
  assert.equal(stored.webViewLink, "/api/v3/local-files/doc-12");
  assert.deepEqual(await storage.findByDocumentId(12), stored);
  const back = await storage.downloadFile("doc-12");
  assert.equal(back.mimeType, "application/pdf");
  assert.equal(back.filename, "PO-1.pdf");
  assert.equal(back.data.toString(), "%PDF-1");
});

test("差し替えは同じ id のまま中身だけ変わる", async () => {
  const storage = new LocalFileStorage(tmp());
  await storage.uploadPdf({ documentId: 3, filename: "a.pdf", pdf: Buffer.from("old") });
  const updated = await storage.updatePdf({ fileId: "doc-3", pdf: Buffer.from("new") });
  assert.equal(updated.id, "doc-3");
  assert.equal((await storage.downloadFile("doc-3")).data.toString(), "new");
  await assert.rejects(storage.updatePdf({ fileId: "doc-99", pdf: Buffer.from("x") }), /ありません/);
});

test("任意ファイルは MIME と名前を保って取り出せる", async () => {
  const storage = new LocalFileStorage(tmp());
  const stored = await storage.uploadFile({ filename: "契約書.docx", mimeType: "application/msword", data: Buffer.from("doc") });
  assert.match(stored.id, /^f-/);
  const back = await storage.downloadFile(stored.id);
  assert.equal(back.mimeType, "application/msword");
  assert.equal(back.filename, "契約書.docx");
});

test("パスの外へ出る id は受け付けない", async () => {
  const storage = new LocalFileStorage(tmp());
  await assert.rejects(storage.downloadFile("../etc/passwd"), /不正/);
  await assert.rejects(storage.downloadFile(".hidden"), /不正/);
  await assert.rejects(storage.downloadFile("doc-1/x"), /不正/);
});

test("ローカル保存のリンクからも id が取れる（Drive のリンクと同じ関数で）", () => {
  assert.equal(localFileIdFromLink("/api/v3/local-files/doc-12"), "doc-12");
  assert.equal(localFileIdFromLink("https://drive.google.com/file/d/abcdefghij1/view"), null);
  assert.equal(driveFileIdFromLink("/api/v3/local-files/doc-12"), "doc-12");
  assert.equal(driveFileIdFromLink("https://drive.google.com/file/d/abcdefghij1/view"), "abcdefghij1");
  assert.equal(driveIdFromUrl("http://backup-pc:8080/api/v3/local-files/f-abc-def"), "f-abc-def");
  assert.equal(driveIdFromUrl("https://drive.google.com/drive/folders/abcdefghij1"), "abcdefghij1");
});
