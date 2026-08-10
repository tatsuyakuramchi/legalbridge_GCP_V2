import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createSettingsRouter } from "./settings-routes.js";
import { MemoryAppSettingsRepository } from "./settings-repository.js";

function appFor(opts: { enabled?: boolean; role?: string; forbidden?: boolean; seed?: Record<string, string> } = {}) {
  const repository = new MemoryAppSettingsRepository(opts.seed ?? { COMPANY_NAME: "旧社名" }, opts.forbidden ?? false);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createSettingsRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("settings: admin 以外は403（読取）", async () => {
  const res = await request(appFor({ role: "legal" }).app).get("/api/v2/settings");
  assert.equal(res.status, 403);
});

test("settings: 現在値＋フィールド定義を返す", async () => {
  const res = await request(appFor({ enabled: false }).app).get("/api/v2/settings").expect(200);
  assert.equal(res.body.values.COMPANY_NAME, "旧社名");
  assert.equal(res.body.writeEnabled, false);
  assert.ok(res.body.fields.some((f: { key: string }) => f.key === "COMPANY_REGISTRATION_NUMBER"));
});

test("settings: 書込無効時は503", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/settings").send({ settings: { COMPANY_NAME: "新社名" } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SETTINGS_WRITE_UNAVAILABLE");
});

test("settings: 保存して現在値を返す", async () => {
  const target = appFor({ enabled: true });
  const res = await request(target.app).post("/api/v2/settings")
    .send({ settings: { COMPANY_NAME: "アークライト株式会社", COMPANY_TEL: "03-0000-0000" } }).expect(200);
  assert.equal(res.body.saved, 2);
  assert.equal(res.body.values.COMPANY_NAME, "アークライト株式会社");
  assert.equal(await target.repository.get(["COMPANY_TEL"]).then((v) => v.COMPANY_TEL), "03-0000-0000");
});

test("settings: allowlist 外キーは400", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/settings").send({ settings: { INTEGRATION_MODE: "live" } });
  assert.equal(res.status, 400);
});

test("settings: 空は400", async () => {
  const res = await request(appFor({ enabled: true }).app).post("/api/v2/settings").send({ settings: {} });
  assert.equal(res.status, 400);
});

test("settings: 権限未整備(FORBIDDEN_DB)は503", async () => {
  const res = await request(appFor({ enabled: true, forbidden: true }).app)
    .post("/api/v2/settings").send({ settings: { COMPANY_NAME: "X" } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SETTINGS_FORBIDDEN_DB");
});
