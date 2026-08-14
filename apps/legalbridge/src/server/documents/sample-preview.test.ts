import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createTemplateSampleRouter } from "./sample-preview-routes.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import { buildSampleFormData, sampleValueForField, sampleVariantsFor } from "./sample-preview.js";
import type { DocumentFormSchema } from "../../types.js";

// ── 純関数 ─────────────────────────────────────────────────────────────────

test("sampleValueForField: placeholder の「例:」を最優先で使う", () => {
  assert.equal(
    sampleValueForField("TERRITORY", { name: "TERRITORY", placeholder: "例: Republic of Korea" }),
    "Republic of Korea");
  assert.equal(
    sampleValueForField("AGREEMENT_STATUS",
      { name: "AGREEMENT_STATUS", type: "select", options: ["DRAFT FOR DISCUSSION", "EXECUTION VERSION"] }),
    "DRAFT FOR DISCUSSION");
  assert.equal(sampleValueForField("ANNEX_1_INCLUDED", { name: "ANNEX_1_INCLUDED", type: "boolean" }), true);
});

test("buildSampleFormData: overrides が最後に勝つ・schema外の {{VAR}} も埋まる", () => {
  const data = buildSampleFormData(
    [{ name: "TRANSACTION_MODEL", type: "select", options: ["License-Out", "Product-Out", "Both"] }],
    "<p>{{TRANSACTION_MODEL}} {{EXTRA_VAR}}</p>", "IGLA",
    { TRANSACTION_MODEL: "Product-Out" });
  assert.equal(data.TRANSACTION_MODEL, "Product-Out");
  assert.equal(data.EXTRA_VAR, "[EXTRA_VAR]");
  assert.equal(data.summary, "IGLA サンプル");
});

test("sampleVariantsFor: IGLA 2テンプレは取引モデル別の2バリアント", () => {
  for (const key of ["igla_license_en", "igla_license_annex_en"]) {
    const variants = sampleVariantsFor(key);
    assert.deepEqual(variants.map((v) => v.id), ["license-out", "product-out"]);
    assert.equal(variants[0].overrides.TRANSACTION_MODEL, "License-Out");
    assert.equal(variants[1].overrides.TRANSACTION_MODEL, "Product-Out");
  }
  assert.equal(sampleVariantsFor("license_out_en").length, 1);
});

// ── ルート ──────────────────────────────────────────────────────────────────

const schemas: DocumentFormSchema[] = [
  { templateKey: "license_out_en", templateVersionId: 1, label: "LICENSE AGREEMENT（ライセンスアウト）",
    category: "License", fields: [{ name: "LICENSEE_NAME", placeholder: "例: Sample Licensee Inc." }] },
  { templateKey: "igla_license_en", templateVersionId: 2, label: "IGLA", category: "License",
    fields: [{ name: "TRANSACTION_MODEL", type: "select", options: ["License-Out", "Product-Out", "Both"] }] },
  { templateKey: "individual_license_terms", templateVersionId: 3, label: "旧個別許諾", category: "License", fields: [] },
  { templateKey: "individual_license_terms_v3", templateVersionId: 4, label: "個別利用許諾条件書（v3）", category: "License", fields: [] }
];
const html = {
  license_out_en: "<h1>LICENSE AGREEMENT</h1><p>Licensee: {{LICENSEE_NAME}}</p>",
  igla_license_en:
    '<h1>IGLA</h1>{{#if (ne TRANSACTION_MODEL "Product-Out")}}<h2>SCHEDULE 1</h2>{{/if}}' +
    '{{#if (ne TRANSACTION_MODEL "License-Out")}}<h2>SCHEDULE 2</h2>{{/if}}',
  individual_license_terms: "<p>hidden</p>",
  individual_license_terms_v3:
    "<h1>{{contractNo}}</h1><p>{{licensorName}}</p>" +
    "{{#each conds}}<li>{{condLabel}} {{condName}} {{appliedRate}}</li>{{/each}}" +
    "{{#each lcs}}<td>{{lcId}} {{lcName}}</td>{{/each}}"
};

function app(authenticated = true) {
  const a = express();
  a.use((_req, res, next) => {
    if (authenticated) res.locals.currentUser = { email: "u@example.com", role: "requester", subject: "u", source: "iap" };
    next();
  });
  a.use("/api/v2", createTemplateSampleRouter(new MemoryTemplateRepository(schemas, html)));
  return a;
}

test("一覧: 認証済みなら全ロール取得可・IGLAは2バリアント・非表示テンプレ除外", async () => {
  const res = await request(app()).get("/api/v2/template-samples");
  assert.equal(res.status, 200);
  const keys = res.body.templates.map((t: { templateKey: string }) => t.templateKey);
  assert.ok(keys.includes("license_out_en"));
  assert.ok(keys.includes("igla_license_en"));
  assert.ok(!keys.includes("individual_license_terms"));
  const igla = res.body.templates.find((t: { templateKey: string }) => t.templateKey === "igla_license_en");
  assert.deepEqual(igla.variants.map((v: { id: string }) => v.id), ["license-out", "product-out"]);
});

test("未認証は401", async () => {
  const res = await request(app(false)).get("/api/v2/template-samples");
  assert.equal(res.status, 401);
});

test("html: サンプル値で描画される（placeholder 由来の値）", async () => {
  const res = await request(app()).get("/api/v2/template-samples/license_out_en/html");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /html/);
  assert.ok(res.text.includes("Sample Licensee Inc."));
});

test("html: IGLA はバリアントで Schedule の出力が切り替わる", async () => {
  const lo = await request(app()).get("/api/v2/template-samples/igla_license_en/html?variant=license-out");
  assert.ok(lo.text.includes("SCHEDULE 1") && !lo.text.includes("SCHEDULE 2"));
  const po = await request(app()).get("/api/v2/template-samples/igla_license_en/html?variant=product-out");
  assert.ok(!po.text.includes("SCHEDULE 1") && po.text.includes("SCHEDULE 2"));
  // variant 省略時は先頭バリアント（license-out）
  const def = await request(app()).get("/api/v2/template-samples/igla_license_en/html");
  assert.ok(def.text.includes("SCHEDULE 1"));
});

test("html: v3（日本語版ライセンスイン）は専用サンプルのマトリクスで描画される", async () => {
  const res = await request(app()).get("/api/v2/template-samples/individual_license_terms_v3/html");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("LIC-LO-2026-0015-ILT-0001"));
  assert.ok(res.text.includes("株式会社オリジナル（サンプル）"));
  // 加算型: 構成要素料率の合算（5%+2%）／非加算型: 固定料率
  assert.ok(res.text.includes("条件1 製造・販売 7%"));
  assert.ok(res.text.includes("条件2 サブライセンス 50%"));
  assert.ok(res.text.includes("LO-2026-0015-001 原作ゲーム（A）"));
});

test("一覧: v3 は表示・旧 individual_license_terms のみ非表示", async () => {
  const res = await request(app()).get("/api/v2/template-samples");
  const keys = res.body.templates.map((t: { templateKey: string }) => t.templateKey);
  assert.ok(keys.includes("individual_license_terms_v3"));
  assert.ok(!keys.includes("individual_license_terms"));
});

test("html: 不明バリアントは400・未知テンプレ/非表示テンプレは404", async () => {
  const bad = await request(app()).get("/api/v2/template-samples/igla_license_en/html?variant=nope");
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.variants, ["license-out", "product-out"]);
  assert.equal((await request(app()).get("/api/v2/template-samples/unknown/html")).status, 404);
  assert.equal((await request(app()).get("/api/v2/template-samples/individual_license_terms/html")).status, 404);
});
