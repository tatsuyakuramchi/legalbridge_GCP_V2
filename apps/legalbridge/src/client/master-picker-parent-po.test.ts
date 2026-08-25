import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPatch, isInspectionSchema, isPurchaseOrderDocument
} from "./MasterDataPicker.js";
import type { DocumentFormSchema, TemplateField } from "../types";

// 検収書フォームで「親の発注書」を選んだときの引用（V1 ステップ1相当）。
// 055 で発注番号系の孤児項目を消したとき、文書タブの出現条件も一緒に消えて
// 「親POの検索画面がない」状態になっていた。テンプレート種別で常に出し、
// 引用は明細（delivery_line_items）まで写す。

const inspectionSchema = (...fields: TemplateField[]): DocumentFormSchema => ({
  templateKey: "inspection_certificate", templateVersionId: 5, label: "検収書",
  fields: [
    { name: "projectTitle", label: "件名", type: "text" },
    { name: "taxRate", label: "消費税率", type: "number" },
    { name: "counterparty", label: "相手方名称", type: "text" },
    ...fields
  ]
} as DocumentFormSchema);

const PO_ITEM = {
  id: "1086", type: "document" as const, label: "ARC-PO-2026-0117",
  description: "発注書・株式会社エー",
  values: {
    document_number: "ARC-PO-2026-0117",
    template_type: "purchase_order",
    vendor_name: "株式会社エー",
    PROJECT_TITLE: "キャラクターイラスト制作",
    taxRate: "10",
    items: [
      {
        item_name: "キービジュアル", spec: "A4 350dpi", quantity: 2,
        unit_price: 50000, amount_ex_tax: 100000, delivery_date: "2026-09-30",
        deliverable_ownership: "発注者", calc_method: "FIXED"
      },
      {
        item_name: "利用許諾", spec: "", quantity: 1,
        unit_price: 0, amount_ex_tax: 0,
        deliverable_ownership: "受注者", calc_method: "ROYALTY",
        royalty_calc_basis: "販売額", rate_pct: 5
      }
    ]
  }
};

test("検収書テンプレートかどうかの判定", () => {
  assert.equal(isInspectionSchema(inspectionSchema()), true);
  assert.equal(isInspectionSchema({
    templateKey: "purchase_order", templateVersionId: 22, label: "発注書", fields: []
  } as DocumentFormSchema), false);
});

test("発注書系の文書だけを親POとして扱う", () => {
  assert.equal(isPurchaseOrderDocument({ template_type: "purchase_order" }), true);
  assert.equal(isPurchaseOrderDocument({ template_type: "purchase_order_v2" }), true);
  assert.equal(isPurchaseOrderDocument({ template_type: "intl_purchase_order" }), true);
  assert.equal(isPurchaseOrderDocument({ template_type: "outsourcing" }), false);
  assert.equal(isPurchaseOrderDocument({}), false);
});

test("発注明細が検収明細として引用される（全量検収が初期値）", () => {
  const patch = buildPatch(inspectionSchema(), {}, PO_ITEM);
  const lines = patch.delivery_line_items as Array<Record<string, unknown>>;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].item_name, "キービジュアル");
  assert.equal(lines[0].spec, "A4 350dpi");
  assert.equal(lines[0].inspected_quantity, 2);
  assert.equal(lines[0].inspected_amount_ex_tax, 100000);
  assert.equal(lines[0].delivery_date, "2026-09-30");
});

test("0円の業績連動行は金額0のまま取り込み、出し分け用の列も写す", () => {
  // V1 と同じ：利用許諾型（受注者帰属・ROYALTY）は検収書で
  // 「利用許諾料に含む／業績連動報酬（別途算定）」の表記に使う。
  const patch = buildPatch(inspectionSchema(), {}, PO_ITEM);
  const royalty = (patch.delivery_line_items as Array<Record<string, unknown>>)[1];
  assert.equal(royalty.inspected_amount_ex_tax, 0);
  assert.equal(royalty.deliverable_ownership, "受注者");
  assert.equal(royalty.calc_method, "ROYALTY");
  assert.equal(royalty.royalty_calc_basis, "販売額");
  assert.equal(royalty.rate_pct, 5);
});

test("金額列が無い明細は 数量×単価 で補完する", () => {
  const item = {
    ...PO_ITEM,
    values: {
      ...PO_ITEM.values,
      items: [{ item_name: "ロゴ", quantity: 3, unit_price: 20000 }]
    }
  };
  const patch = buildPatch(inspectionSchema(), {}, item);
  const lines = patch.delivery_line_items as Array<Record<string, unknown>>;
  assert.equal(lines[0].inspected_amount_ex_tax, 60000);
});

test("件名・税率・相手方も引用される", () => {
  const patch = buildPatch(inspectionSchema(), {}, PO_ITEM);
  assert.equal(patch.projectTitle, "キャラクターイラスト制作");
  assert.equal(patch.taxRate, "10");
  assert.equal(patch.counterparty, "株式会社エー");
});

test("取込文書の発注書（title/counterparty/document_date キー）からも件名・相手方・発注日が引用される", () => {
  // 過去文書取込は form_data に title / counterparty / document_date を記録する。
  // V1 由来のキー（PROJECT_TITLE / vendor_name / ORDER_DATE）が無くても引用が効くこと。
  const imported = {
    id: "500", type: "document" as const, label: "PO-2019-0001",
    values: {
      document_number: "PO-2019-0001", template_type: "purchase_order",
      title: "旧・業務委託発注書", counterparty: "株式会社ビー", document_date: "2019-03-05",
      items: [{ item_name: "イラスト制作", quantity: 10, unit_price: 30000 }]
    }
  };
  const schema = inspectionSchema({ name: "orderDate", label: "発注日", type: "date" } as TemplateField);
  const patch = buildPatch(schema, {}, imported);
  assert.equal(patch.projectTitle, "旧・業務委託発注書");
  assert.equal(patch.counterparty, "株式会社ビー");
  assert.equal(patch.orderDate, "2019-03-05");
  const lines = patch.delivery_line_items as Array<Record<string, unknown>>;
  assert.equal(lines[0].inspected_amount_ex_tax, 300000);
});

test("発注書以外の文書（基本契約など）では検収明細を触らない", () => {
  const contract = {
    id: "12", type: "document" as const, label: "ARC-OUT-2025-0007",
    values: {
      document_number: "ARC-OUT-2025-0007", template_type: "outsourcing",
      CONTRACT_TITLE: "制作業務委託基本契約",
      items: [{ item_name: "誤って写ってはいけない行" }]
    }
  };
  const patch = buildPatch(inspectionSchema(), {}, contract);
  assert.equal("delivery_line_items" in patch, false);
});

test("検収書以外のテンプレートでは発注書を選んでも明細を写さない", () => {
  // 発注書フォームで基本契約タブから別の発注書を引いたときに、
  // 自分の明細が上書きされる事故を防ぐ。
  const poSchema = {
    templateKey: "purchase_order", templateVersionId: 22, label: "発注書",
    fields: [{ name: "MASTER_CONTRACT_REF", label: "基本契約名", type: "text" }]
  } as DocumentFormSchema;
  const patch = buildPatch(poSchema, {}, PO_ITEM);
  assert.equal("delivery_line_items" in patch, false);
});

test("明細が空の発注書では検収明細を空配列で上書きしない", () => {
  const item = { ...PO_ITEM, values: { ...PO_ITEM.values, items: [] } };
  const patch = buildPatch(inspectionSchema(), {}, item);
  assert.equal("delivery_line_items" in patch, false);
});

test("経費・手数料は精算候補（po_*）として持ち込み、支払額には自動で含めない", () => {
  const item = {
    ...PO_ITEM,
    values: {
      ...PO_ITEM.values,
      expenses: [{ expense_name: "取材交通費", amount_inc_tax: 5500 }],
      other_fees: [{ fee_name: "振込手数料", amount_ex_tax: 440 }]
    }
  };
  const patch = buildPatch(inspectionSchema(), {}, item);
  const poExpenses = patch.po_expenses as Array<Record<string, unknown>>;
  assert.equal(poExpenses.length, 1);
  assert.equal(poExpenses[0].line_no, 1);
  assert.equal((patch.po_other_fees as unknown[]).length, 1);
  // 「今回含める」チェック（または最終検収トグル）で初めて expenses/other_fees に入る。
  assert.equal("expenses" in patch, false);
  assert.equal("other_fees" in patch, false);
});
