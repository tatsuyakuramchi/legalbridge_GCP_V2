import assert from "node:assert/strict";
import test from "node:test";
import { validateContractIntake } from "./intake.js";

const baseInput = {
  sourceWork: {
    title: "原作テスト",
    workType: "board_game"
  },
  ownWork: {
    title: "自社作品テスト",
    workType: "board_game",
    status: "planning"
  },
  materials: [{
    materialName: "ゲームデザイン",
    materialType: "game_design",
    materialRole: "core_logic",
    acquisitionType: "license",
    rightsType: "license",
    isDefault: true
  }],
  contract: {
    documentNumber: "TEST-LIC-2026-0001",
    contractTitle: "テスト利用許諾契約",
    primaryVendorId: 18,
    executedAt: "2026-08-01"
  },
  inboundConditions: [{
    conditionName: "原作利用許諾",
    transactionKind: "license",
    materialIndex: 0,
    territory: "日本",
    languages: ["日本語"],
    paymentScheme: "royalty",
    ratePct: 5
  }],
  outboundConditions: []
};

test("締結済契約取込の登録計画を返す", () => {
  const result = validateContractIntake(baseInput);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.sourceWork, "create");
  assert.equal(result.plan.materialsToCreate, 1);
  assert.equal(result.plan.inboundConditionsToCreate, 1);
  assert.equal(result.plan.integrations.slack, "disabled");
});

test("既存IDと新規名称を同時指定した作品を拒否する", () => {
  const result = validateContractIntake({
    ...baseInput,
    sourceWork: {
      existingWorkId: 1,
      title: "重複指定"
    }
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.field === "sourceWork.existingWorkId"));
});

test("存在しないイン条件を親にしたアウト条件を拒否する", () => {
  const result = validateContractIntake({
    ...baseInput,
    outboundConditions: [{
      conditionName: "アウト条件",
      transactionKind: "license",
      materialIndex: 0,
      territory: "全世界",
      languages: ["英語"],
      paymentScheme: "royalty",
      ratePct: 8,
      counterpartyVendorId: 20,
      parentInboundIndex: 3
    }]
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some(
    (error) => error.field === "outboundConditions.0.parentInboundIndex"
  ));
});

test("ロイヤリティ以外の条件に料率を指定した場合は拒否する", () => {
  const result = validateContractIntake({
    ...baseInput,
    inboundConditions: [{
      conditionName: "一括利用料",
      transactionKind: "license",
      materialIndex: 0,
      territory: "日本",
      languages: ["日本語"],
      paymentScheme: "lump_sum",
      amountExTax: 100000,
      ratePct: 5
    }]
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some(
    (error) => error.field === "inboundConditions.0.ratePct"
  ));
});
