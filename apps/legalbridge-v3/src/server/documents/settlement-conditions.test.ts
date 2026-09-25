import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentIssueService } from "./issue-service.js";
import { ConditionWriteService } from "../conditions/write-service.js";
import { expenseLinesFrom, feeLinesFrom, isSettlementKind, materializeSettlementRows } from "./settlement-conditions.js";

/**
 * 発注書の「その他手数料」「経費」の行は、決定のときに fee / expense の条件になり、
 * 文書と案件に繋がる。行には condition_id が書き戻るので、二度目は作らない。
 */
const manual = {
  other_fees: [{ fee_name: "送料", amount: 3000, remarks: "着払い分" }, { fee_name: "", amount: "" }],
  expenses: [{ expense_name: "交通費", amount_inc_tax: "12,000", spent_date: "2026-09-01", remarks: "往復" },
             { condition_id: 77, expense_name: "宿泊費", amount_inc_tax: 9000 }]
};

const build = (over: { templateKey?: string; manual?: Record<string, unknown>; links?: number[] } = {}) => {
  let next = 200;
  return new FakeDatabase((text) => {
    if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) {
      return [{ id: 1, status: "draft", template_version_id: 401, matter_id: 501, agreement_id: null,
                manual_inputs: over.manual ?? manual }];
    }
    if (text.includes("FROM document_template_versions tv JOIN document_templates t")) {
      return [{ template_id: 301, version_id: 401, template_key: over.templateKey ?? "purchase_order",
                label: "発注書", number_prefix: "PO", category: "order", html_source: "<p>{{DOC_NO}}</p>",
                variables: [{ name: "DOC_NO", from: "document.number" }] }];
    }
    if (text.includes("COALESCE(max(line_no), 0)")) return [{ n: (over.links ?? [5]).length }];
    if (text.includes("FROM document_conditions WHERE document_id")) {
      return (over.links ?? [5]).map((id) => ({ condition_id: id }));
    }
    if (text.includes("AND status IN ('void', 'superseded')")) return [];
    if (text.includes("SELECT counterparty_id, agreement_id, currency, term_start, term_end")) {
      // pg は date 列を Date で返す。文字列にせず渡すと INSERT が落ちる。
      return [{ counterparty_id: 9, agreement_id: 33, currency: "JPY", term_start: new Date("2026-09-01T00:00:00Z"),
                term_end: new Date("2027-03-31T00:00:00Z"), tax_category: "taxable" }];
    }
    if (text.includes("FROM parties WHERE id")) return [{ id: 9, name: "受託者" }];
    if (text.includes("SELECT id FROM matters WHERE id")) return [{ id: 501 }];
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) { next += 1; return [{ current_value: next }]; }
    if (text.includes("INSERT INTO document_sequences")) return [{ current_value: 7 }];
    if (text.includes("FROM conditions WHERE condition_no")) return [];
    if (text.includes("INSERT INTO conditions")) return [{ id: next, condition_no: `CL-2026-00${next}` }];
    if (text.includes("FROM conditions c")) {
      return [{ id: 5, condition_no: "CL-2026-00005", name: "翻訳", direction: "in", kind: "service",
                currency: "JPY", pricing_model: "fixed", flat_amount: 100000, tax_category: "taxable",
                agreement_id: 33, party_name: "受託者", party_kind: "individual" }];
    }
    if (text.includes("FROM matters m")) return [{ id: 501, matter_no: "MTR-1", title: "翻訳の業務", kind: "service" }];
    if (text.includes("FROM settings WHERE key")) return [{ value: { name: "株式会社サンプル出版" } }];
    if (text.includes("UPDATE documents")) return [{ issued_at: "2026-09-15T10:00:00Z" }];
    return undefined;
  });
};

test("決定で、条件の無い手数料・経費の行から条件を作り、文書と案件に繋ぐ", async () => {
  const db = build();
  const result = await new DocumentIssueService(db).issue(1, "k");

  const inserts = db.all("INSERT INTO conditions");
  assert.equal(inserts.length, 2, "空の行と condition_id の付いた行は作らない");
  // [kind, name, counterparty, agreement, flat_amount, tax_category, notes]
  assert.deepEqual(inserts.map((q) => [q.params[3], q.params[4], q.params[5], q.params[1], q.params[18], q.params[21], q.params[24]]),
    [["fee", "送料", 9, 33, 3000, "taxable", "着払い分"],
     ["expense", "交通費", 9, 33, 12000, "exempt", "利用日 2026-09-01／往復／税込の実費"]]);
  assert.deepEqual(inserts.map((q) => [q.params[11], q.params[12]]),
    [["2026-09-01", "2027-03-31"], ["2026-09-01", "2027-03-31"]], "期間は先頭の条件（委託料）から写す");

  const links = db.all("INSERT INTO document_conditions");
  assert.deepEqual(links.map((q) => q.params), [[1, 201, 2], [1, 202, 3]], "文書の末尾に繋ぐ");
  const matterLinks = db.all("INSERT INTO matter_links");
  assert.deepEqual(matterLinks.map((q) => [q.params[0], q.params[1]]), [[501, "201"], [501, "202"]], "案件にも繋ぐ");
  assert.deepEqual(result.conditionIds, [5, 201, 202]);

  // 行に condition_id が書き戻る。
  const saved = db.all("UPDATE documents SET manual_inputs");
  assert.equal(saved.length, 1);
  const written = JSON.parse(String(saved[0].params[1]));
  assert.equal(written.other_fees[0].condition_id, 201);
  assert.equal(written.other_fees[1].condition_id, undefined, "空の行はそのまま");
  assert.equal(written.expenses[0].condition_id, 202);
  assert.equal(written.expenses[1].condition_id, 77, "既に繋がっている行はそのまま");

  const audit = db.all("INSERT INTO audit_events").find((q) => q.params[1] === "document.issue")!;
  const detail = JSON.parse(String(audit.params[5]));
  assert.deepEqual(detail.createdConditions.map((c: { kind: string; name: string }) => [c.kind, c.name]),
    [["fee", "送料"], ["expense", "交通費"]]);
});

test("全部の行に condition_id が付いていれば何も作らない（作り直しでも二重にならない）", async () => {
  const db = build({ manual: {
    other_fees: [{ condition_id: 71, fee_name: "送料", amount: 3000 }],
    expenses: [{ condition_id: 72, expense_name: "交通費", amount_inc_tax: 12000 }]
  } });
  await new DocumentIssueService(db).issue(1, "k");
  assert.equal(db.all("INSERT INTO conditions").length, 0);
  assert.equal(db.all("UPDATE documents SET manual_inputs").length, 0);
});

test("発注書・検収書以外のひな形では行を条件にしない", async () => {
  const db = build({ templateKey: "royalty_statement" });
  await new DocumentIssueService(db).issue(1, "k");
  assert.equal(db.all("INSERT INTO conditions").length, 0);
});

test("文書に条件が1本も無ければ相手先が決まらないので作らない", async () => {
  const db = build({ links: [] });
  const out = await materializeSettlementRows(db as never, new ConditionWriteService(db), {
    documentId: 1, templateKey: "purchase_order", matterId: 501, conditionIds: [], manual
  }, "k");
  assert.deepEqual(out.created, []);
  assert.equal(out.manual, manual, "手入力は触らない");
});

test("繋がっている fee / expense の条件は、その他手数料・経費の行の種になる", () => {
  const conditions = [
    { id: 5, kind: "service", name: "翻訳", flatAmount: 100000 },
    { id: 201, kind: "fee", name: "送料", flatAmount: 3000, notes: "着払い分" },
    { id: 202, kind: "expense", name: "交通費", flatAmount: 12000 }
  ];
  assert.deepEqual(feeLinesFrom(conditions), [{ condition_id: 201, fee_name: "送料", amount: 3000, remarks: "着払い分" }]);
  assert.deepEqual(expenseLinesFrom(conditions),
    [{ condition_id: 202, expense_name: "交通費", amount_inc_tax: 12000, spent_date: null, remarks: "" }]);
  assert.equal(isSettlementKind("fee"), true);
  assert.equal(isSettlementKind("service"), false);
});
