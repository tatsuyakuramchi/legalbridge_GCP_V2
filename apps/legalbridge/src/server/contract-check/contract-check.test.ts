import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  normalizeName, findPurpose, buildMasterContractSummary, buildPurposeResult,
  CONTRACT_PURPOSES, type VendorDocumentRow, type MasterContracts
} from "./engine.js";
import { createContractCheckRouter } from "./routes.js";
import { MemoryContractCheckRepository, type VendorCandidate } from "./repository.js";

const doc = (over: Partial<VendorDocumentRow>): VendorDocumentRow => ({
  recordType: "master_contract", contractCategory: "service", contractTitle: "基本契約",
  documentNumber: "K-1", contractStatus: "executed", effectiveDate: "2024-01-01",
  expirationDate: null, autoRenewal: false, documentUrl: null, legalonUrl: null,
  cloudsignUrl: null, driveUrl: null, conditionNumber: null, originalWork: null,
  workName: null, productName: null, media: null, territory: null, language: null,
  scope: null, isPrimary: true, lifecycleStatus: "final", ...over
});
const masters = (over: Partial<Record<"service" | "license" | "publication", boolean>> = {}): MasterContracts =>
  buildMasterContractSummary([
    ...(over.service ? [doc({ contractCategory: "service" })] : []),
    ...(over.license ? [doc({ contractCategory: "license" })] : []),
    ...(over.publication ? [doc({ contractCategory: "publication" })] : [])
  ]);

test("契約チェック: 名称正規化（NFKC・空白・法人格・括弧）", () => {
  assert.equal(normalizeName("株式会社　アークライト"), "アークライト");
  assert.equal(normalizeName("（株）テスト"), "テスト");   // 全角括弧は NFKC で半角化→ (株) 除去
  assert.equal(normalizeName("ＡＢＣ商会"), "ABC商会");
  assert.equal(normalizeName(""), "");
});

test("契約チェック: service 系＝基本契約ありなら発注書で進行可能", () => {
  const r = buildPurposeResult({}, masters({ service: true }), findPurpose("service_general"));
  assert.equal(r.judgmentLabel, "発注書で進行可能");
  assert.equal(r.legalReviewRequired, false);
  assert.equal(r.recommendedDocumentType, "purchase_order");
  const ng = buildPurposeResult({}, masters(), findPurpose("service_general"));
  assert.equal(ng.legalReviewRequired, true);
  assert.equal(ng.recommendedDocumentType, "legal_review");
});

test("契約チェック: license 系＝再許諾/海外フラグで法務確認へ格上げ（理由は追記）", () => {
  const ok = buildPurposeResult({}, masters({ license: true }), findPurpose("license_in"));
  assert.equal(ok.judgmentLabel, "個別利用許諾条件書で確認");
  const up = buildPurposeResult({ includesSublicense: true }, masters({ license: true }), findPurpose("license_in"));
  assert.equal(up.judgmentLabel, "再許諾・海外展開を含むため、法務確認を推奨");
  assert.equal(up.legalReviewRequired, true);
  assert.equal(up.recommendedDocumentType, "license_condition");   // 推奨文書は据え置き（V1 準拠）
  assert.match(up.reasonSummary, /ただし、再許諾や海外展開が含まれる場合/);
});

test("契約チェック: publication 系＝常に法務・映像ゲーム化は個別検討", () => {
  const pub = buildPurposeResult({}, masters({ publication: true }), findPurpose("publication_paper"));
  assert.equal(pub.judgmentLabel, "出版契約書の作成が必要");
  assert.equal(pub.legalReviewRequired, true);
  const vg = buildPurposeResult({}, masters(), findPurpose("publication_video_game"));
  assert.equal(vg.recommendedDocumentType, "legal_review");
});

test("契約チェック: 用途未選択・unknown・複合の定型", () => {
  assert.equal(buildPurposeResult({}, masters(), null).judgmentLabel, "用途未選択");
  assert.equal(buildPurposeResult({}, masters(), findPurpose("unknown")).judgmentLabel, "法務確認を推奨");
  assert.equal(buildPurposeResult({}, masters(), findPurpose("mixed_service_license")).judgmentLabel,
    "複合取引のため、法務確認が必要");
});

test("契約チェック: master サマリは final・正本を優先（V1 の非決定を改良）", () => {
  const m = buildMasterContractSummary([
    doc({ documentNumber: "OLD", lifecycleStatus: "superseded", isPrimary: false }),
    doc({ documentNumber: "NEW", lifecycleStatus: "final", isPrimary: true })
  ]);
  assert.equal(m.service.documentNumber, "NEW");
  assert.equal(m.service.label, "締結済");
});

function appFor() {
  const vendors: VendorCandidate[] = [
    { id: 1, vendorCode: "V001", vendorName: "株式会社アークライト", entityType: "corporate", tradeName: null, penName: null },
    { id: 2, vendorCode: "V002", vendorName: "アーク商事", entityType: "corporate", tradeName: null, penName: null }
  ];
  const docs = new Map([[1, [doc({ contractCategory: "service" })]]]);
  const numbers = new Map([["ARC-PO-2026-0001", {
    documentNumber: "ARC-PO-2026-0001", recordType: "individual_contract", contractTitle: "発注書",
    contractStatus: "executed", vendorName: "株式会社アークライト", vendorCode: "V001",
    entityType: "corporate", issueKey: "LEGAL-1"
  }]]);
  const app = express();
  app.use(express.json());
  app.use("/api/v2", createContractCheckRouter(new MemoryContractCheckRepository(vendors, docs, numbers)));
  return app;
}

test("契約チェック: purposes は17件・snake_case", async () => {
  const res = await request(appFor()).get("/api/v2/contract-check/purposes").expect(200);
  assert.equal(res.body.length, CONTRACT_PURPOSES.length);
  assert.equal(res.body[0].purpose_code, "service_general");
});

test("契約チェック: 単一ヒットで判定つきフル応答", async () => {
  const res = await request(appFor()).post("/api/v2/contract-check/search")
    .send({ counterpartyName: "株式会社アークライト", purposeCode: "service_general" }).expect(200);
  assert.equal(res.body.counterparty.vendorId, 1);
  assert.equal(res.body.masterContracts.service.exists, true);
  assert.equal(res.body.purposeResult.judgmentLabel, "発注書で進行可能");
  assert.equal(res.body.suggestedAction.legalReviewRequired, false);
});

test("契約チェック: 複数候補は multiple:true・results 配列", async () => {
  const res = await request(appFor()).post("/api/v2/contract-check/search")
    .send({ counterpartyName: "アーク", purposeCode: "" }).expect(200);
  assert.equal(res.body.multiple, true);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.results.length, 2);
});

test("契約チェック: 未検出は notFound 定型", async () => {
  const res = await request(appFor()).post("/api/v2/contract-check/search")
    .send({ counterpartyName: "存在しない社名", purposeCode: "service_general" }).expect(200);
  assert.equal(res.body.counterparty, null);
  assert.equal(res.body.purposeResult.judgmentLabel, "取引先が見つかりません");
});

test("契約チェック: counterpartyName 欠落は400", async () => {
  const res = await request(appFor()).post("/api/v2/contract-check/search").send({});
  assert.equal(res.status, 400);
});

test("契約チェック: lookup-number found/not-found", async () => {
  const hit = await request(appFor()).post("/api/v2/contract-check/lookup-number")
    .send({ documentNumber: "arc-po-2026-0001" }).expect(200);
  assert.equal(hit.body.found, true);
  assert.equal(hit.body.issueKey, "LEGAL-1");
  const miss = await request(appFor()).post("/api/v2/contract-check/lookup-number")
    .send({ documentNumber: "ARC-XX-0000" }).expect(200);
  assert.equal(miss.body.found, false);
});
