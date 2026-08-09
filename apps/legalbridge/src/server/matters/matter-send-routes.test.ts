import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterSendRouter } from "./matter-send-routes.js";
import { MemoryMatterSendRepository } from "./matter-send-repository.js";

function appFor(options: { enabled?: boolean; role?: "admin" | "legal" | "requester"; sends?: MemoryMatterSendRepository | null }) {
  const sends = options.sends === null ? undefined : (options.sends ?? new MemoryMatterSendRepository());
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createMatterSendRouter(sends, options.enabled ?? true));
  return { app, sends };
}

test("送信記録→一覧で新しい順に返る", async () => {
  const { app } = appFor({ enabled: true });
  const rec = await request(app).post("/api/v2/matters/5/sends")
    .send({ documentId: 9, channel: "email", recipient: "a@example.com", subject: "契約書送付" });
  assert.equal(rec.status, 201);
  assert.equal(rec.body.send.channel, "email");
  assert.equal(rec.body.send.sentBy, "u@arclight.co.jp");
  const list = await request(app).get("/api/v2/matters/5/sends");
  assert.equal(list.status, 200);
  assert.equal(list.body.enabled, true);
  assert.equal(list.body.sends.length, 1);
  assert.equal(list.body.sends[0].recipient, "a@example.com");
});

test("台帳未設定なら一覧は enabled=false、記録は503", async () => {
  const { app } = appFor({ sends: null });
  const list = await request(app).get("/api/v2/matters/5/sends");
  assert.equal(list.body.enabled, false);
  const rec = await request(app).post("/api/v2/matters/5/sends").send({ documentId: 9 });
  assert.equal(rec.status, 503);
});

test("依頼者は参照も記録もできない", async () => {
  const list = await request(appFor({ role: "requester" }).app).get("/api/v2/matters/5/sends");
  assert.equal(list.status, 403);
  const rec = await request(appFor({ role: "requester" }).app).post("/api/v2/matters/5/sends").send({ documentId: 9 });
  assert.equal(rec.status, 403);
});

test("documentId 無し・不正 channel は400", async () => {
  const { app } = appFor({ enabled: true });
  assert.equal((await request(app).post("/api/v2/matters/5/sends").send({})).status, 400);
  assert.equal((await request(app).post("/api/v2/matters/5/sends").send({ documentId: 9, channel: "fax" })).status, 400);
});

test("書込無効時の記録は503（読取は可）", async () => {
  const { app } = appFor({ enabled: false });
  const rec = await request(app).post("/api/v2/matters/5/sends").send({ documentId: 9 });
  assert.equal(rec.status, 503);
  assert.equal((await request(app).get("/api/v2/matters/5/sends")).status, 200);
});
