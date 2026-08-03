import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createPendingInspectionRouter } from "./routes.js";
import { MemoryPendingInspectionRepository, type PendingInspectionRow } from "./repository.js";

function po(overrides: Partial<PendingInspectionRow>): PendingInspectionRow {
  return {
    id: 1, documentNumber: "PO-1", issueKey: "LEGAL-1", matterId: 5,
    matterCode: "MTR-2026-00005", matterTitle: "案件A", createdAt: "2026-08-01T00:00:00.000Z",
    hasInspection: false, ...overrides
  };
}
function appFor(rows: PendingInspectionRow[] | undefined) {
  const app = express();
  app.use("/api/v2", createPendingInspectionRouter(
    rows === undefined ? undefined : new MemoryPendingInspectionRepository(rows)
  ));
  return app;
}

test("リポジトリ未接続時は503を返す", async () => {
  const response = await request(appFor(undefined)).get("/api/v2/pending-inspections");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "PENDING_INSPECTIONS_UNAVAILABLE");
});

test("既定では検収書未作成の発注書のみ返す", async () => {
  const response = await request(appFor([
    po({ id: 1, hasInspection: false }),
    po({ id: 2, hasInspection: true })
  ])).get("/api/v2/pending-inspections");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].id, 1);
});

test("pending=0 で全発注書を返す", async () => {
  const response = await request(appFor([
    po({ id: 1, hasInspection: false }),
    po({ id: 2, hasInspection: true })
  ])).get("/api/v2/pending-inspections?pending=0");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
});
