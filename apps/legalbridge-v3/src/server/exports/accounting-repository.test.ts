import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { AccountingExportRepository, documentLinesFrom, documentTitleFrom, statementGroupLabel } from "./accounting-repository.js";

/** 台帳から出した計算書の支払。案件が無く、実績も計算書に結ばれていない。 */
const payment = {
  id: 41, payment_no: "PAY-2026-01043", currency: "JPY", amount: 1352760, tax_amount: 135276,
  withholding_amount: 201756, due_on: "2026-10-20", paid_on: null, status: "planned",
  party_code: "V-1", party_name: "平沢 茂之", name_kana: null, party_kind: "individual",
  invoice_no: null, withholding: true, residency: null, treaty_rate_pct: null,
  treaty_docs_received_on: null, account_holder_kana: null,
  matter_no: null, matter_title: null, owner_name: null, owner_department: null
};

const db = (over: Record<string, any[]> = {}) => new FakeDatabase((t) => {
  for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
  if (t.includes("FROM payments y")) return [payment];
  if (t.includes("FROM payment_allocations al\n    JOIN conditions c")) {
    return [{ payment_id: 41, amount: 1352760, condition_no: "CL-2026-00408", name: "自社製造・他社販売",
              tax_category: "taxable", kind: "license", currency: "JPY", unit_amount: null,
              quantity: null, occurred_on: "2026-09-30" }];
  }
  if (t.includes("FROM staff WHERE id = ANY")) return [{ id: 5, name: "加来 健", department: "ライセンス部" }];
  return [];
});

test("実績から書類に辿れない支払は、支払を立てたときの記録から書類を引く（件名・担当者も）", async () => {
  const repo = new AccountingExportRepository(db({
    "a.action = 'payment.create'": [{
      payment_id: 41, documents: 1, document_id: 900, document_no: "ARC-RS-2026-0123",
      template_key: "royalty_statement", owner_staff_id: 5,
      rendered_values: { originalWork: "ゲームブック" }
    }]
  }));
  const out = await repo.build({ from: "2026-10-01", to: "2026-10-31" });
  const group = out.groups[0]!;
  assert.equal(group.owner, "加来 健");
  const row = group.rows[0]!;
  assert.equal(row.documentNo, "ARC-RS-2026-0123");
  assert.equal(row.title, "ゲームブック 利用許諾料のご報告");
  assert.equal(row.department, "ライセンス部");
});

test("書類も担当も無ければ、これまでどおり条件名と「担当者未設定」", async () => {
  const out = await new AccountingExportRepository(db()).build({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(out.groups[0]!.owner, "(担当者未設定)");
  assert.equal(out.groups[0]!.rows[0]!.title, "自社製造・他社販売");
  assert.equal(out.groups[0]!.rows[0]!.documentNo, null);
});

test("案件の担当があればそちらが勝つ", async () => {
  const repo = new AccountingExportRepository(db({
    "FROM payments y": [{ ...payment, owner_name: "南", owner_department: "法務", matter_title: "案件A" }],
    "a.action = 'payment.create'": [{ payment_id: 41, documents: 1, document_id: 900, document_no: "ARC-RS-1",
      template_key: "inspection_certificate", owner_staff_id: 5, rendered_values: { title: "紙の件名" } }]
  }));
  const out = await repo.build({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(out.groups[0]!.owner, "南");
  // 件名は紙に刷った件名（案件名より優先）。
  assert.equal(out.groups[0]!.rows[0]!.title, "紙の件名");
});

test("書類の件名：検収書は件名らしい欄を順に、計算書は紙の件名「◯◯ 利用許諾料のご報告」", () => {
  assert.equal(documentTitleFrom({ PROJECT_TITLE: "保守", title: "" }, "inspection_certificate"), "保守");
  assert.equal(documentTitleFrom({}), null);
  assert.equal(documentTitleFrom(null), null);
  assert.equal(documentTitleFrom({ originalWork: "ゲームブック", contractTitle: "Hachette" }, "royalty_statement"),
    "ゲームブック 利用許諾料のご報告");
  assert.equal(documentTitleFrom({}, "royalty_statement"), "利用許諾料のご報告");
});

test("社内の担当者を付け替えてあれば、案件の担当より優先する", async () => {
  const repo = new AccountingExportRepository(db({
    "FROM payments y": [{ ...payment, owner_name: "南", owner_department: "法務" }],
    "a.action = 'payment.create'": [{ payment_id: 41, documents: 1, document_id: 900, document_no: "ARC-RS-1",
      template_key: "royalty_statement", owner_staff_id: null, account_owner_staff_id: 5, rendered_values: {} }]
  }));
  const out = await repo.build({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(out.groups[0]!.owner, "加来 健");
  assert.equal(out.groups[0]!.rows[0]!.department, "ライセンス部");
});

test("計算書の支払内容は小計の括り（入金企業・言語）1つで1組", () => {
  const values = { lineGroups: [
    { contractTitle: "Hachette　仏語版", payerName: "Hachette", languageLabel: "フランス語", subtotalPayment: 300,
      lines: [{ productName: "X（フランス語）", paymentJpy: 100, occurredOn: "2026-09-01" },
              { productName: "同上", paymentJpy: 200, occurredOn: "2026-09-30" }] },
    // 前の版で決定した計算書（入金企業・言語を持っていない）
    { contractTitle: "Planeta　西語版", subtotalPayment: 50,
      lines: [{ productName: "X（スペイン語）", paymentJpy: 50, occurredOn: "2026-09-30" }] }
  ] };
  const lines = documentLinesFrom(values);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { content: "Hachette・フランス語", unitPrice: null, quantity: 1, amount: 300, deliveryDate: "2026-09-30" });
  assert.equal(lines[1]!.content, "Planeta・スペイン語");
  assert.equal(statementGroupLabel({ contractTitle: "", contractNumber: "C-1" }, [{ productName: "" }]), "C-1");
});

test("支払内容の言語は「◯◯語」だけ（製品名の括弧に並ぶ地域は落とす）", () => {
  assert.equal(statementGroupLabel({ contractTitle: "Asmodee Asia Limited　英語版" },
    [{ productName: "トーネードスプラッシュ（英語・中国・アメリカ合衆国・韓国）" }]), "Asmodee Asia Limited・英語");
  assert.equal(statementGroupLabel({ contractTitle: "MM-Spiele　独語版" },
    [{ productName: "X（ドイツ語・ドイツ・オーストリア・スイス）" }]), "MM-Spiele・ドイツ語");
  // 言語が無く地域だけなら、そのまま出す。
  assert.equal(statementGroupLabel({ contractTitle: "A社" }, [{ productName: "X（北米）" }]), "A社・北米");
});

test("計算書の支払内容：対象契約（イン側の契約）を入金企業として拾わない。前の版の計算書だけ拾う", () => {
  const rows = [{ productName: "おたずねマもの村（日本語・日本）" }];
  // 自社製造・自社販売：入金企業は空。対象契約はイン側の契約。
  assert.equal(statementGroupLabel({ contractTitle: "2025年7月31日付利用許諾契約書", contractNumber: "ARC-ILT-2026-0037",
                                     payerName: "", languageLabel: "日本語" }, rows), "日本語");
  // 再許諾：入金企業は許諾先。
  assert.equal(statementGroupLabel({ contractTitle: "2024年4月1日付利用許諾基本契約 / 2025年7月31日付利用許諾契約書",
                                     payerName: "Korea Board games Co., Ltd.", languageLabel: "韓国語" }, rows),
               "Korea Board games Co., Ltd.・韓国語");
  // 入金企業を持たない前の版：対象契約の先頭（入金企業）から拾う。
  assert.equal(statementGroupLabel({ contractTitle: "Asmodee Asia Limited　英語版" }, [{ productName: "" }]),
               "Asmodee Asia Limited・英語版");
});

test("支払に載った実績の締めの回の名前を持つ（支払先ごとにまとめるときの支払内容）", async () => {
  const repo = new AccountingExportRepository(db({
    "FROM payment_allocations al\n    JOIN conditions c": [
      { payment_id: 41, amount: 1000000, condition_no: "CL-1", name: "電子出版", tax_category: "taxable", kind: "license",
        currency: "JPY", unit_amount: null, quantity: null, occurred_on: "2026-06-30", round_label: "2025年7月〜2026年6月" },
      { payment_id: 41, amount: 352760, condition_no: "CL-2", name: "紙出版", tax_category: "taxable", kind: "license",
        currency: "JPY", unit_amount: null, quantity: null, occurred_on: "2026-06-30", round_label: "2025年7月〜2026年6月" }
    ]
  }));
  const out = await repo.build({ from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(out.groups[0]!.rows[0]!.roundLabels, ["2025年7月〜2026年6月"]);
  const db2 = db();
  await new AccountingExportRepository(db2).build({ from: "2026-10-01", to: "2026-10-31" });
  assert.match(db2.find("FROM payment_allocations al\n    JOIN conditions c")!.text, /LEFT JOIN condition_schedules sc ON sc\.id = e\.schedule_id/);
});
