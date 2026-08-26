import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createConditionSyncRouter } from "./condition-sync-routes.js";
import { MemoryConditionSyncRepository } from "./condition-sync-repository.js";
import { MemoryDocumentRegistryRepository } from "./registry-repository.js";

function appFor(options: {
  enabled?: boolean; role?: string;
  formData?: Record<string, unknown>; voided?: boolean;
} = {}) {
  const registry = new MemoryDocumentRegistryRepository([{
    id: 1, documentNumber: "ILT-2026-0001", issueKey: "LEGAL-1",
    templateType: "individual_license_terms", templateVersionId: 3,
    title: "利用許諾条件書", counterparty: "甲社", driveLink: "",
    createdAt: "2026-08-25T00:00:00.000Z", createdBy: null,
    lifecycleStatus: options.voided ? "voided" : "final",
    formData: options.formData ?? {}
  }]);
  const conditionSync = new MemoryConditionSyncRepository();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "a@x.jp", subject: "s", role: options.role ?? "admin", source: "disabled" } as never;
    next();
  });
  app.use("/api/v2", createConditionSyncRouter({
    registry, conditionSync, writeEnabled: options.enabled ?? true
  }));
  return { app, conditionSync };
}

const FORM = { financial_conditions: [{ condition_no: 1, condition_name: "利用許諾料", rate_pct: 10 }] };

test("condition-sync: 条件データを台帳へ同期し件数を返す", async () => {
  const { app, conditionSync } = appFor({ formData: FORM });
  const response = await request(app).post("/api/v2/documents/1/conditions/sync");
  assert.equal(response.status, 200);
  assert.equal(response.body.written, 1);
  assert.equal(conditionSync.documents.get(1)!.get(1)!.condition_name, "利用許諾料");
});

test("condition-sync: 条件データ無しは422・無効化文書は409・不在は404", async () => {
  const noData = await request(appFor({ formData: {} }).app).post("/api/v2/documents/1/conditions/sync");
  assert.equal(noData.status, 422);
  assert.equal(noData.body.code, "CONDITION_SYNC_NO_DATA");
  const voided = await request(appFor({ formData: FORM, voided: true }).app)
    .post("/api/v2/documents/1/conditions/sync");
  assert.equal(voided.status, 409);
  const missing = await request(appFor({ formData: FORM }).app).post("/api/v2/documents/99/conditions/sync");
  assert.equal(missing.status, 404);
});

test("condition-sync: 依頼者は403・無効時は503", async () => {
  const denied = await request(appFor({ formData: FORM, role: "requester" }).app)
    .post("/api/v2/documents/1/conditions/sync");
  assert.equal(denied.status, 403);
  const disabled = await request(appFor({ formData: FORM, enabled: false }).app)
    .post("/api/v2/documents/1/conditions/sync");
  assert.equal(disabled.status, 503);
});
