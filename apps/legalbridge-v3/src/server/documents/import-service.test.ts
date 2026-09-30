import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentImportService } from "./import-service.js";
import { MemoryDriveStorage } from "./drive-storage.js";

const db = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) {
      if (t.includes(fragment)) return rows;
    }
    if (t.includes("FROM conditions WHERE id = ANY")) return [{ id: 5 }];
    if (t.includes("FROM matters WHERE id")) return [{ id: 3 }];
    if (t.includes("INSERT INTO document_sequences")) return [{ current_value: 1 }];
    if (t.includes("INSERT INTO documents")) return [{ id: 42 }];
    return [];
  });

const pdf = (bytes = 100) => ({
  filename: "契約書.pdf", mimeType: "application/pdf", data: Buffer.alloc(bytes, 1)
});

const input = (over: Record<string, unknown> = {}) => ({
  title: "業務委託契約書（甲社）", documentKind: "業務委託契約書",
  conditionIds: [5], file: pdf(), ...over
} as any);

test("取込文書はひな形を持たない行として入る", async () => {
  const database = db();
  const r = await new DocumentImportService(database, new MemoryDriveStorage())
    .import(input(), "legal@arch.co.jp");

  const insert = database.find("INSERT INTO documents")!;
  assert.match(insert.text, /template_version_id/);
  assert.match(insert.text, /VALUES \(\$1, NULL,/,
    "ひな形の無い文書を入れる経路が無かったので、取込文書を登録できなかった");
  assert.equal(r.id, 42);
});

test("発行済みとして入る（下書きだと実績にも送付にも繋げない）", async () => {
  const database = db();
  await new DocumentImportService(database, new MemoryDriveStorage()).import(input(), "a");
  assert.match(database.find("INSERT INTO documents")!.text, /'issued'/);
});

test("種別ごとの接頭辞で採番する（自社発行の PO・RS とは混ざらない）", async () => {
  const database = db();
  const r = await new DocumentImportService(database, new MemoryDriveStorage()).import(input(), "a");
  assert.match(r.documentNo, /^ARC-SVC-\d{4}-0001$/);
  assert.equal(database.find("INSERT INTO document_sequences")!.params[0], "SVC");
});

test("種別が表に無ければ IMP", async () => {
  const database = db();
  const r = await new DocumentImportService(database, new MemoryDriveStorage())
    .import(input({ documentKind: "自由記述" }), "a");
  assert.match(r.documentNo, /^ARC-IMP-\d{4}-0001$/);
});

test("依頼を付けると依頼に繋がる（デイリータスクの進み具合に数える）", async () => {
  const database = db();
  await new DocumentImportService(database, new MemoryDriveStorage()).import(input({ requestId: 9 }), "a");
  const link = database.find("INSERT INTO intake_request_links")!;
  assert.deepEqual(link.params, [9, 42, "a"]);
});

test("番号を先に取る：番号だけの下書き（ファイル待ち）を作って番号を返す", async () => {
  const database = db();
  const r = await new DocumentImportService(database, null)
    .reserve({ title: "覚書（甲社）", documentKind: "覚書", conditionIds: [5], requestId: 9 }, "legal");
  assert.match(r.documentNo, /^ARC-MOU-\d{4}-0001$/);
  const insert = database.find("INSERT INTO documents")!;
  assert.match(insert.text, /'draft'/);
  assert.match(insert.text, /VALUES \(\$1, NULL,/);
  assert.match(String(insert.params[3]), /"reserved":true/);
  assert.deepEqual(database.find("INSERT INTO document_conditions")!.params, [42, 5, 1]);
  assert.deepEqual(database.find("INSERT INTO intake_request_links")!.params, [9, 42, "legal"]);
  assert.equal(database.find("INSERT INTO audit_events")!.params[1], "document.reserve");
});

test("番号を先に取るには種別と文書名が要る", async () => {
  await assert.rejects(() => new DocumentImportService(db(), null)
    .reserve({ title: " ", documentKind: "覚書", conditionIds: [] }, "a"), /文書名は必須/);
  await assert.rejects(() => new DocumentImportService(db(), null)
    .reserve({ title: "x", documentKind: "", conditionIds: [] }, "a"), /種別を選んで/);
});

const reservedRow = (over: Record<string, unknown> = {}) => ({
  id: 42, document_no: "ARC-MOU-2026-0001", status: "draft", template_version_id: null,
  manual_inputs: { title: "覚書（甲社）", documentKind: "覚書", imported: true, reserved: true }, ...over
});

test("ファイルを付けると発行済みになる（番号はそのまま）", async () => {
  const drive = new MemoryDriveStorage();
  const database = db({
    "FROM documents WHERE id = $1": [reservedRow()],
    "UPDATE documents": [{ id: 42, document_no: "ARC-MOU-2026-0001" }],
    "FROM document_conditions WHERE document_id": [{ condition_id: 5 }]
  });
  const r = await new DocumentImportService(database, drive)
    .attachFile(42, { receivedOn: "2026-09-30", file: pdf() }, "legal");
  assert.equal(r.documentNo, "ARC-MOU-2026-0001");
  assert.deepEqual(r.conditionIds, [5]);
  assert.equal(drive.fileUploads.length, 1);
  const upd = database.find("UPDATE documents")!;
  assert.match(upd.text, /status = 'issued'/);
  assert.match(String(upd.params[4]), /"reserved":false/);
  assert.equal(database.find("INSERT INTO audit_events")!.params[1], "document.import");
});

test("ファイルを付けられるのは番号を先に取った下書きだけ", async () => {
  const svc = (row: Record<string, unknown>) =>
    new DocumentImportService(db({ "FROM documents WHERE id = $1": [row] }), new MemoryDriveStorage());
  await assert.rejects(() => svc(reservedRow({ status: "issued" })).attachFile(42, { file: pdf() }, "a"),
    /もうファイルが付いています/);
  await assert.rejects(() => svc(reservedRow({ template_version_id: 7 })).attachFile(42, { file: pdf() }, "a"),
    /番号を先に取った文書/);
  await assert.rejects(() => new DocumentImportService(db(), new MemoryDriveStorage())
    .attachFile(99, { file: pdf() }, "a"), /見つかりません/);
});

test("条件に繋ぐ（繋がないと、どの取引の根拠か分からない文書になる）", async () => {
  const database = db();
  await new DocumentImportService(database, new MemoryDriveStorage()).import(input(), "a");
  const link = database.find("INSERT INTO document_conditions")!;
  assert.deepEqual(link.params, [42, 5, 1]);
});

test("ファイルを先に預けてから行を作る", async () => {
  const drive = new MemoryDriveStorage();
  await new DocumentImportService(db(), drive).import(input(), "a");
  // 行を先に作って保存に失敗すると、中身の無い文書が登録済みとして残る。
  assert.equal(drive.fileUploads.length, 1);
  assert.equal(drive.fileUploads[0].mimeType, "application/pdf");
});

test("保存先が未設定なら取り込ませない", async () => {
  await assert.rejects(
    () => new DocumentImportService(db(), null).import(input(), "a"),
    /ファイルの保存先が設定されていません/);
});

test("実行できる形式は受けない", async () => {
  await assert.rejects(
    () => new DocumentImportService(db(), new MemoryDriveStorage())
      .import(input({ file: { filename: "x.exe", mimeType: "application/x-msdownload",
                             data: Buffer.alloc(10) } }), "a"),
    /この形式は取り込めません/);
});

test("大きすぎるファイルは受けない", async () => {
  await assert.rejects(
    () => new DocumentImportService(db(), new MemoryDriveStorage())
      .import(input({ file: pdf(26 * 1024 * 1024) }), "a"), /大きすぎます/);
});

test("空のファイルは受けない", async () => {
  await assert.rejects(
    () => new DocumentImportService(db(), new MemoryDriveStorage())
      .import(input({ file: pdf(0) }), "a"), /ファイルが空です/);
});

test("文書名は必須", async () => {
  await assert.rejects(
    () => new DocumentImportService(db(), new MemoryDriveStorage())
      .import(input({ title: "  " }), "a"), /文書名は必須です/);
});

test("存在しない条件には繋がせない", async () => {
  await assert.rejects(
    () => new DocumentImportService(db({ "FROM conditions WHERE id = ANY": [] }),
      new MemoryDriveStorage()).import(input(), "a"), /存在しない条件/);
});

test("取り込みも監査に残す", async () => {
  const database = db();
  await new DocumentImportService(database, new MemoryDriveStorage())
    .import(input(), "legal@arch.co.jp");
  const audit = database.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "document.import");
});
