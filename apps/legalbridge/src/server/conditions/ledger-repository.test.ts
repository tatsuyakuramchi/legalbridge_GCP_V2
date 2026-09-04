import assert from "node:assert/strict";
import test from "node:test";
import {
  PgConditionLedgerRepository, buildLedgerFormData, type LedgerClient, type LedgerDatabase
} from "./ledger-repository.js";
import { emptyLedgerPayload, type ConditionLedgerPayload } from "../../condition-ledger.js";

// Pg 実装の SQL 発行列を台本式の偽クライアントで検証する（実DBなし）。

type Issued = { text: string; params: unknown[] };

function fakeDatabase(options: { contractInsertFails?: boolean } = {}) {
  const issued: Issued[] = [];
  const respond = async (text: string, params: unknown[] = []) => {
    issued.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(text)) return { rows: [] };
    if (text.includes("INSERT INTO document_sequences")) return { rows: [{ current_value: 42 }] };
    if (text.includes("INSERT INTO contracts")) {
      if (options.contractInsertFails) throw Object.assign(new Error("check violation"), { code: "23514" });
      return { rows: [{ id: 900 }] };
    }
    if (text.includes("INSERT INTO contract_works")) return { rows: [] };
    if (text.includes("INSERT INTO documents")) return { rows: [{ id: 501 }] };
    if (text.includes("FROM documents d") && text.includes("WHERE d.id = $1")) {
      return { rows: [{
        id: params[0], document_number: "CT-2026-00042", contract_id: options.contractInsertFails ? null : 900,
        form_data: buildLedgerFormData(samplePayload()), created_at: "2026-09-04T00:00:00Z", updated_at: null,
        created_by: "legal@example.com", vendor_id: 7, vendor_name: "スタジオ雨宿り", work_title: "作品",
        line_count: 3, linked_count: 0
      }] };
    }
    if (text.includes("FOR UPDATE")) return { rows: [{ id: params[0], document_number: "CT-2026-00042", contract_id: 900 }] };
    if (text.includes("row_to_json(cl)")) {
      return { rows: [{ line: { id: 1, line_no: 2001, line_code: "CL-2026-00001", line_kind: "expense", tax_category: "taxable", direction: "payable", amount_ex_tax: "20000" } }] };
    }
    if (text.includes("form_data->>'condition_ledger_id' = $1::text")) return { rows: [] };
    if (text.startsWith("UPDATE documents") && text.includes("||")) {
      return { rows: [{ id: params[0], document_number: "PO-2025-0083", template_type: "purchase_order", template_version_id: null, lifecycle_status: null, title: "旧発注書" }] };
    }
    return { rows: [] };
  };
  const client: LedgerClient = { query: respond, release() { /* noop */ } };
  const database: LedgerDatabase = { query: respond, connect: async () => client };
  return { database, issued };
}

function samplePayload(): ConditionLedgerPayload {
  return {
    ...emptyLedgerPayload(), entry: "work", workId: 13, workCode: "WRK-10013", workTitle: "作品",
    vendorId: 7, vendorName: "スタジオ雨宿り", title: "イラスト制作・原作許諾", termStart: "2026-04-01",
    kinds: ["service", "license_in"],
    payments: [{ scheme: "lump_sum", materialCode: "", name: "制作費", amountExTax: 300000, paymentTerms: "" }]
  };
}

test("Pg: 作成は CT 採番→契約ヘッダ（SAVEPOINT）→ documents(condition_ledger) の順で発行し form_data に台帳キーを持つ", async () => {
  const fake = fakeDatabase();
  const summary = await new PgConditionLedgerRepository(fake.database).create(samplePayload(), "legal@example.com");
  assert.equal(summary.documentNumber, "CT-2026-00042");
  assert.equal(summary.contractId, 900);
  assert.equal(summary.status, "draft");
  const seq = fake.issued.find((q) => q.text.includes("INSERT INTO document_sequences"));
  assert.match(seq!.text, /'condition_ledger'/);
  const contract = fake.issued.find((q) => q.text.includes("INSERT INTO contracts"));
  assert.equal(contract!.params[0], "CT-2026-00042");
  assert.equal(contract!.params[1], "service_agreement");
  assert.equal(contract!.params[4], "drafting");      // 下書き＝lifecycle_stage drafting
  assert.equal(contract!.params[8], "draft");         // contract_status draft
  assert.ok(fake.issued.some((q) => q.text.includes("INSERT INTO contract_works") && q.params[1] === 13));
  const doc = fake.issued.find((q) => q.text.includes("INSERT INTO documents"));
  assert.equal(doc!.params[2], "condition_ledger");
  assert.equal(doc!.params[6], 900);                  // contract_id
  const formData = JSON.parse(String(doc!.params[3]));
  assert.equal(formData.ledger_status, "draft");
  assert.equal(formData.work_code, "WRK-10013");      // 条件同期の resolveDocumentWork が読むキー
  assert.equal(formData.counterparty, "スタジオ雨宿り");
  assert.equal(formData.title, "イラスト制作・原作許諾");
  const savepointAt = fake.issued.findIndex((q) => q.text === "SAVEPOINT ledger_contract");
  const documentAt = fake.issued.findIndex((q) => q.text.includes("INSERT INTO documents"));
  assert.ok(savepointAt >= 0 && savepointAt < documentAt);
  assert.ok(fake.issued.some((q) => q.text === "COMMIT"));
});

test("Pg: 契約ヘッダが作れなくても（CHECK/grant 違反）SAVEPOINT へ戻して台帳は成立する", async () => {
  const fake = fakeDatabase({ contractInsertFails: true });
  const summary = await new PgConditionLedgerRepository(fake.database).create(samplePayload(), null);
  assert.equal(summary.contractId, null);
  assert.ok(fake.issued.some((q) => q.text === "ROLLBACK TO SAVEPOINT ledger_contract"));
  const doc = fake.issued.find((q) => q.text.includes("INSERT INTO documents"));
  assert.equal(doc!.params[6], null);
  assert.ok(fake.issued.some((q) => q.text === "COMMIT"));
  assert.equal(fake.issued.some((q) => q.text === "ROLLBACK"), false);
});

test("Pg: 更新は documents の列レベル grant の範囲（form_data / vendor_id / updated_at）だけを書き、確定で契約を executed にする", async () => {
  const fake = fakeDatabase();
  await new PgConditionLedgerRepository(fake.database).update(501, { ...samplePayload(), status: "final" });
  const update = fake.issued.find((q) => q.text.startsWith("UPDATE documents"));
  assert.match(update!.text, /SET form_data = \$2::jsonb, vendor_id = \$3, updated_at = now\(\)/);
  assert.doesNotMatch(update!.text, /lifecycle_status|contract_id|document_number/);
  assert.equal(JSON.parse(String(update!.params[1])).ledger_status, "final");
  const contract = fake.issued.find((q) => q.text.startsWith("UPDATE contracts"));
  assert.equal(contract!.params[3], "executed");
  assert.equal(contract!.params[4], "executed");
});

test("Pg: 詳細は列名を固定せず（row_to_json）行を読み、紐づけは対象文書の form_data にキーをマージ追記する", async () => {
  const fake = fakeDatabase();
  const repository = new PgConditionLedgerRepository(fake.database);
  const detail = await repository.find(501);
  assert.equal(detail?.lines[0].lineKind, "expense");
  assert.equal(detail?.lines[0].taxCategory, "taxable");
  assert.equal(detail?.lines[0].amountExTax, 20000);
  assert.equal(detail?.payload.kinds.length, 2);
  const linked = await repository.attach(501, 77);
  assert.equal(linked.documentNumber, "PO-2025-0083");
  const attach = fake.issued.find((q) => q.text.startsWith("UPDATE documents") && q.text.includes("||"));
  const patch = JSON.parse(String(attach!.params[1]));
  assert.deepEqual(patch, { condition_ledger_id: "501", condition_ledger_number: "CT-2026-00042", work_code: "WRK-10013" });
  assert.match(attach!.text, /template_type <> \$3/);    // 台帳そのものには紐づけない
  await assert.rejects(repository.attach(501, 501), /台帳そのもの/);
});
