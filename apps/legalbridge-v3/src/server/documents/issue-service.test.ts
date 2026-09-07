import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentIssueService } from "./issue-service.js";
import { DomainError } from "../core/errors.js";

interface Options { status?: string; blockedConditions?: Array<Record<string, unknown>>; variables?: unknown }

const responder = (options: Options = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) {
    return [{ id: 1, status: options.status ?? "draft", template_version_id: 401,
              matter_id: 501, agreement_id: 201, manual_inputs: { PERIOD: "2026上期" } }];
  }
  if (text.includes("FROM document_template_versions tv JOIN document_templates t")) {
    return [{ template_id: 301, version_id: 401, template_key: "royalty_statement",
              label: "利用許諾料計算書", number_prefix: "RS",
              html_source: "<h1>{{LICENSEE_NAME}} {{HONORIFIC}}</h1><p>{{PERIOD}}</p><p>{{DOC_NO}}</p>",
              variables: options.variables ?? [
                { name: "LICENSEE_NAME", from: "agreement.counterparty.name", required: true },
                { name: "HONORIFIC", from: "agreement.counterparty.honorific" },
                { name: "PERIOD", from: "manual", required: true, label: "対象期間" },
                { name: "DOC_NO", from: "document.number" }
              ] }];
  }
  if (text.includes("FROM document_conditions WHERE document_id")) return [{ condition_id: 5 }];
  if (text.includes("AND status IN ('void', 'superseded')")) return options.blockedConditions ?? [];
  if (text.includes("INSERT INTO document_sequences")) return [{ current_value: 7 }];
  if (text.includes("FROM conditions c")) {
    return [{ id: 5, condition_no: "CL-2026-00042", name: "繁体字版 電子書籍 配信許諾",
              direction: "out", kind: "license", currency: "JPY", pricing_model: "revenue_rate",
              rate_ppm: 125000, flat_amount: null, mg_amount: 1200000, ag_amount: 800000,
              tax_category: "taxable", agreement_id: 201,
              party_name: "晨光數位出版", party_kind: "corporate", work_title: "星降る夜のミュゼ" }];
  }
  if (text.includes("FROM agreements a")) {
    return [{ id: 201, agreement_no: "AGR-2026-0088", title: "繁体字版 配信許諾契約",
              direction: "out", status: "executed",
              party_name: "晨光數位出版", party_kind: "corporate" }];
  }
  if (text.includes("FROM matters m")) return [{ id: 501, matter_no: "MTR-2026-00218", title: "繁体字版 配信許諾", kind: "work" }];
  if (text.includes("FROM settings WHERE key")) return [{ value: { name: "株式会社サンプル出版" } }];
  if (text.includes("FROM condition_scopes")) return [{ condition_id: 5, scope_type: "region", label: "台湾" }];
  if (text.includes("UPDATE documents")) return [{ issued_at: "2026-09-07T10:00:00Z" }];
  return undefined;
};

test("発行で採番し、確定値を焼き付ける", async () => {
  const db = new FakeDatabase(responder());
  const result = await new DocumentIssueService(db).issue(1, "kuramochi");

  assert.equal(result.documentNo, "ARC-RS-2026-0007");
  assert.deepEqual(result.conditionIds, [5]);

  const update = db.find("UPDATE documents");
  const values = JSON.parse(String(update!.params[2]));
  assert.equal(values.LICENSEE_NAME, "晨光數位出版", "相手先は合意から解決する");
  assert.equal(values.HONORIFIC, "御中", "法人は御中");
  assert.equal(values.PERIOD, "2026上期", "手入力はそのまま");
  assert.equal(values.DOC_NO, "ARC-RS-2026-0007", "採番した番号が文脈に入る");

  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "document.issue");
  assert.ok(db.texts.includes("COMMIT"));
});

test("下書き以外は発行できない", async () => {
  const db = new FakeDatabase(responder({ status: "issued" }));
  await assert.rejects(
    () => new DocumentIssueService(db).issue(1, "kuramochi"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
  assert.ok(db.texts.includes("ROLLBACK"));
  assert.equal(db.all("INSERT INTO document_sequences").length, 0, "採番を進めない");
});

test("無効・旧版の条件からは文書を出さない", async () => {
  const db = new FakeDatabase(responder({
    blockedConditions: [{ id: 5, condition_no: "CL-2026-00042", status: "superseded" }]
  }));
  await assert.rejects(
    () => new DocumentIssueService(db).issue(1, "kuramochi"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT" && /CL-2026-00042/.test(e.message));
  assert.equal(db.all("INSERT INTO document_sequences").length, 0);
});

test("必須項目が埋まっていなければ発行を止める", async () => {
  const db = new FakeDatabase(responder({
    variables: [{ name: "SIGNER", from: "manual", required: true, label: "署名者" }]
  }));
  await assert.rejects(
    () => new DocumentIssueService(db).issue(1, "kuramochi"),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION" && /署名者/.test(e.message));
  assert.ok(db.texts.includes("ROLLBACK"), "採番ごと巻き戻す");
});

test("下書きの作成では採番しない", async () => {
  const db = new FakeDatabase((text) => {
    if (text.includes("FROM document_templates t JOIN document_template_versions tv")) {
      return [{ template_id: 301, version_id: 401, template_key: "royalty_statement",
                label: "利用許諾料計算書", number_prefix: "RS", html_source: "<p/>", variables: [] }];
    }
    if (text.includes("AND status IN ('void', 'superseded')")) return [];
    if (text.includes("INSERT INTO documents")) return [{ id: 42 }];
    return undefined;
  });
  const result = await new DocumentIssueService(db).createDraft(
    { templateKey: "royalty_statement", conditionIds: [5, 6] }, "kuramochi");

  assert.equal(result.id, 42);
  assert.equal(db.all("INSERT INTO document_sequences").length, 0);
  assert.equal(db.all("INSERT INTO document_conditions").length, 2, "条件を行番号つきで結ぶ");
  assert.deepEqual(db.all("INSERT INTO document_conditions")[1].params, [42, 6, 2]);
});
