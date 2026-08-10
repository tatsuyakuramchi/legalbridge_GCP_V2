import assert from "node:assert/strict";
import test from "node:test";
import { MemoryDraftRepository } from "../documents/draft-repository.js";
import { MemoryTemplateRepository } from "../documents/template-repository.js";
import {
  buildContractIntakeDraftPlans,
  ContractIntakeDocumentBridgeError,
  prepareContractIntakeDocumentDrafts
} from "./intake-document-bridge.js";
import type {
  ContractIntakeDocumentSource
} from "./intake-document-repository.js";
import { contractIntakeSchema } from "./intake.js";

const intake = contractIntakeSchema.parse({
  sourceWork: { existingWorkId: 10 },
  ownWork: { existingWorkId: 11 },
  materials: [{
    existingMaterialId: 100,
    isDefault: true,
    isRoyaltyBearing: true
  }],
  contract: {
    documentNumber: "LIC-2026-0001",
    contractTitle: "原作利用許諾契約",
    primaryVendorId: 20,
    executedAt: "2026-08-01",
    effectiveDate: "2026-08-01"
  },
  inboundConditions: [{
    conditionName: "原作ロイヤリティ",
    transactionKind: "license",
    materialIndex: 0,
    territory: "日本",
    languages: ["日本語"],
    paymentScheme: "royalty",
    ratePct: 5,
    royaltyBase: "純売上額",
    withholdingTaxTreatment: "法令に従い控除"
  }],
  outboundConditions: [{
    conditionName: "国内商品化",
    transactionKind: "license",
    materialIndex: 0,
    territory: "日本",
    languages: ["日本語"],
    exclusivity: "non_exclusive",
    paymentScheme: "royalty",
    ratePct: 8,
    royaltyBase: "希望小売価格",
    counterpartyVendorId: 30,
    parentInboundIndex: 0
  }, {
    conditionName: "英語版商品化",
    transactionKind: "license",
    materialIndex: 0,
    territory: "北米",
    languages: ["英語"],
    exclusivity: "exclusive",
    paymentScheme: "royalty",
    ratePct: 10,
    counterpartyVendorId: 31,
    parentInboundIndex: 0
  }]
});

function source(value = intake): ContractIntakeDocumentSource {
  return {
    documentId: 500,
    contractId: 400,
    documentNumber: value.contract.documentNumber,
    intake: value,
    sourceWork: { id: 10, workCode: "LO-2026-0001", title: "原作作品" },
    ownWork: { id: 11, workCode: "W-2026-0001", title: "自社商品" },
    materials: [{
      id: 100,
      materialCode: "LO-2026-0001-001",
      materialName: "ゲームデザイン",
      rightsHolderLabel: ""
    }],
    vendors: {
      20: vendor(20, "原作権利者"),
      30: vendor(30, "国内ライセンシー"),
      31: vendor(31, "海外ライセンシー")
    },
    outboundConditions: value.outboundConditions
  };
}

function vendor(id: number, vendorName: string) {
  return {
    id,
    vendorName,
    entityType: "法人",
    address: "東京都",
    representative: "代表者",
    contactName: "担当者",
    phone: "",
    email: ""
  };
}

test("個別利用許諾条件書を許諾先ごとの下書きへ分割する", () => {
  const plans = buildContractIntakeDraftPlans(
    source(),
    "individual_license_terms"
  );
  assert.equal(plans.length, 2);
  assert.equal(plans[0].counterpartyName, "国内ライセンシー");
  assert.equal(
    plans[0].formData["Licensee_氏名会社名"],
    "国内ライセンシー"
  );
  const conditions = plans[0].formData.financial_conditions as Array<
    Record<string, unknown>
  >;
  assert.equal(conditions[0].rate_pct, 8);
  assert.equal(conditions[0].subject, "ゲームデザイン");
});

test("自社名は会社プロファイルの値で差し込める（1-6・既定は従来値）", () => {
  const [withDefault] = buildContractIntakeDraftPlans(source(), "individual_license_terms");
  assert.equal(withDefault.formData["Licensor_氏名会社名"], "株式会社アークライト");
  const [custom] = buildContractIntakeDraftPlans(source(), "individual_license_terms", "新社名株式会社");
  assert.equal(custom.formData["Licensor_氏名会社名"], "新社名株式会社");
  assert.equal(custom.formData["PARTY_A_NAME"], "新社名株式会社");
  const [statement] = buildContractIntakeDraftPlans(source(), "royalty_statement", "新社名株式会社");
  assert.equal(statement.formData["payerCompany"], "新社名株式会社");
});

test("利用許諾料明細は料率だけを転記し実績金額を空欄にする", () => {
  const [plan] = buildContractIntakeDraftPlans(
    source(),
    "royalty_statement"
  );
  const lines = plan.formData.lines as Array<Record<string, unknown>>;
  assert.equal(plan.counterpartyName, "原作権利者");
  assert.equal(lines[0].rate_pct, 5);
  assert.equal(lines[0].sales_amount, "");
  assert.equal(lines[0].royalty_amount, "");
  assert.match(String(lines[0].basisNote), /源泉徴収/);
});

test("既存の文書下書きを再作成時に上書きしない", async () => {
  const drafts = new MemoryDraftRepository();
  const templates = new MemoryTemplateRepository([{
    templateKey: "royalty_statement",
    templateVersionId: 1,
    label: "利用許諾料明細書",
    fields: []
  }]);
  const first = await prepareContractIntakeDocumentDrafts(
    source(),
    "royalty_statement",
    drafts,
    templates,
    "admin@arclight.co.jp"
  );
  const second = await prepareContractIntakeDocumentDrafts(
    source(),
    "royalty_statement",
    drafts,
    templates,
    "admin@arclight.co.jp"
  );
  assert.equal(first[0].created, true);
  assert.equal(second[0].created, false);
  assert.equal(first[0].draft.id, second[0].draft.id);
});

test("アウト条件なしでは個別利用許諾条件書を作成しない", () => {
  const withoutOutbound = contractIntakeSchema.parse({
    ...intake,
    outboundConditions: []
  });
  assert.throws(
    () => buildContractIntakeDraftPlans(
      source(withoutOutbound),
      "individual_license_terms"
    ),
    (error: unknown) =>
      error instanceof ContractIntakeDocumentBridgeError &&
      error.code === "OUTBOUND_CONDITIONS_REQUIRED"
  );
});
