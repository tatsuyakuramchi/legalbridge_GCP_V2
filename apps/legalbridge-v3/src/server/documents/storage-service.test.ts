import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentStorageService, safeFilename } from "./storage-service.js";
import { MemoryDriveStorage } from "./drive-storage.js";
import { MemoryPdfRenderer } from "./pdf-renderer.js";
import { DomainError } from "../core/errors.js";

interface Options { status?: string; storageUrl?: string | null }

const responder = (options: Options = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM documents d")) {
    return [{ id: 6, document_no: "ARC-RS-2026-0008", status: options.status ?? "issued",
              template_version_id: 401, matter_id: 1, agreement_id: 201,
              rendered_values: { LICENSEE_NAME: "晨光數位出版" }, manual_inputs: {},
              storage_url: options.storageUrl ?? null, condition_count: 1,
              title: "計算書", counterparty: "晨光數位出版", template_label: "利用許諾料計算書" }];
  }
  if (text.includes("FROM document_conditions dc JOIN conditions")) return [];
  if (text.includes("FROM document_template_versions tv JOIN document_templates t")) {
    return [{ template_id: 301, version_id: 401, template_key: "royalty_statement",
              label: "利用許諾料計算書", number_prefix: "RS",
              html_source: "<p>{{LICENSEE_NAME}}</p>", variables: [] }];
  }
  if (text.includes("FROM document_templates t JOIN document_template_versions tv")) return [];
  return undefined;
};

const service = (options: Options = {}) => {
  const db = new FakeDatabase(responder(options));
  const drive = new MemoryDriveStorage();
  return { db, drive, service: new DocumentStorageService(db, drive, new MemoryPdfRenderer()) };
};

test("発行済み文書をPDFにしてDriveへ上げ、リンクを保存する", async () => {
  const { db, drive, service: storage } = service();
  const result = await storage.store(6, "kuramochi");

  assert.equal(result.mode, "created");
  assert.equal(drive.uploads, 1);
  assert.match(result.storageUrl, /^https:\/\/drive\.google\.com\/file\/d\//);

  const update = db.find("UPDATE documents SET storage_url");
  assert.deepEqual(update!.params, [6, result.storageUrl]);
  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "document.store");
});

test("Drive に同じ文書のファイルがあれば中身だけ差し替えてリンクを保つ", async () => {
  const { drive, service: storage } = service();
  await storage.store(6, "kuramochi");
  const again = await storage.store(6, "kuramochi", { force: true });

  assert.equal(again.mode, "replaced");
  assert.equal(drive.uploads, 1, "新規アップロードは増えない");
  assert.equal(drive.updates, 1, "中身の差し替えになる");
});

test("すでに保存済みなら再アップロードしない（force でやり直せる）", async () => {
  const { drive, service: storage } =
    service({ storageUrl: "https://drive.google.com/file/d/existing/view" });
  const result = await storage.store(6, "kuramochi");
  assert.equal(result.mode, "unchanged");
  assert.equal(drive.uploads, 0);
});

test("下書きは保存できない", async () => {
  const { service: storage } = service({ status: "draft" });
  await assert.rejects(() => storage.store(6, "kuramochi"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
});

test("Drive 未設定なら理由を返して落ちない", async () => {
  const db = new FakeDatabase(responder());
  const storage = new DocumentStorageService(db, null, new MemoryPdfRenderer());
  assert.equal(storage.configured, false);
  await assert.rejects(() => storage.store(6, "kuramochi"),
    (e: unknown) => e instanceof DomainError && e.code === "DB_FORBIDDEN"
      && /GOOGLE_DRIVE_FOLDER_ID/.test(e.message));
});

test("Drive 側の失敗は文書の状態を変えない", async () => {
  const db = new FakeDatabase(responder());
  const failing = {
    async findByDocumentId() { return null; },
    async uploadPdf(): Promise<never> { throw new Error("403 insufficient permissions"); },
    async updatePdf(): Promise<never> { throw new Error("unused"); }
  };
  const storage = new DocumentStorageService(db, failing, new MemoryPdfRenderer());
  await assert.rejects(() => storage.store(6, "kuramochi"),
    (e: unknown) => e instanceof DomainError && /403/.test(e.message));
  assert.equal(db.all("UPDATE documents SET storage_url").length, 0);
});

test("ファイル名は Drive で安全な文字だけにする", () => {
  assert.equal(safeFilename("ARC-RS-2026-0008"), "ARC-RS-2026-0008");
  assert.equal(safeFilename("計算書 2026上期"), "____2026__", "非ASCIIは1文字ずつ _ に置き換わる");
  assert.equal(safeFilename(""), "document");
});
