import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createRequestRouter } from "./routes.js";
import { MemoryRequestRepository, type LegalRequestDetail } from "./repository.js";

function seed(): LegalRequestDetail {
  return {
    id: 1,
    issueKey: "LEGAL-100",
    summary: "利用許諾契約の作成",
    contractType: "license",
    counterparty: "Spiel GmbH",
    slackUserId: "U1",
    deadline: null,
    notes: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    matterCount: 0,
    documentCount: 0,
    legalResponseCount: 0,
    disposition: "received",
    matters: [],
    documents: [],
    contracts: [],
    works: [],
    vendors: [],
    deadlines: []
  };
}
function app(write = false) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = {
      role: "legal",
      email: "legal@example.com",
      subject: "test-user",
      source: "disabled"
    };
    next();
  });
  app.use("/api/v2", createRequestRouter(new MemoryRequestRepository([seed()]), write));
  return app;
}

test("RequestはMatterなしでも一覧・詳細を返せる", async () => {
  const list = await request(app()).get("/api/v2/requests");
  assert.equal(list.status, 200);
  assert.equal(list.body.requests[0].disposition, "received");
  assert.equal(list.body.requests[0].matterCount, 0);

  const detail = await request(app()).get("/api/v2/requests/1");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.matters.length, 0);
  assert.deepEqual(detail.body.contracts, []);
  assert.deepEqual(detail.body.works, []);
  assert.deepEqual(detail.body.vendors, []);
  assert.deepEqual(detail.body.deadlines, []);
});

test("書込有効時はRequestを既存Matterへ紐付けられる", async () => {
  const response = await request(app(true))
    .post("/api/v2/requests/1/link-matter")
    .send({ matterId: 25, primary: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.matterCount, 1);
  assert.equal(response.body.matters[0].id, 25);
  assert.equal(response.body.matters[0].primary, true);
});

test("書込無効時はMatter紐付けを拒否する", async () => {
  const response = await request(app(false))
    .post("/api/v2/requests/1/link-matter")
    .send({ matterId: 25 });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "REQUEST_LINK_WRITE_UNAVAILABLE");
});
