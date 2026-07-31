import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  createApiAuthorization,
  createAuthentication,
  type AuthSettings
} from "./auth.js";

const settings: AuthSettings = {
  mode: "iap",
  adminEmails: new Set(["admin@example.com"]),
  legalEmails: new Set(["legal@example.com"]),
  requesterDomains: new Set(["example.com"])
};

function app(auth: AuthSettings = settings) {
  const target = express();
  target.use(createAuthentication(auth));
  target.use(createApiAuthorization());
  target.get("/api/v2/me", (_request, response) => response.json(response.locals.currentUser));
  target.get("/api/v2/dashboard", (_request, response) => response.json({ ok: true }));
  target.get("/api/v2/documents", (_request, response) => response.json({ ok: true }));
  target.get("/api/v2/admin/summary", (_request, response) => response.json({ ok: true }));
  target.post("/api/v2/documents/preview", (_request, response) => response.json({ ok: true }));
  return target;
}

function identity(email: string) {
  return {
    "x-goog-authenticated-user-email": `accounts.google.com:${email}`,
    "x-goog-authenticated-user-id": "accounts.google.com:subject-1"
  };
}

test("IAP identityがないAPI要求を拒否する", async () => {
  const response = await request(app()).get("/api/v2/me").expect(401);
  assert.equal(response.body.code, "AUTHENTICATION_REQUIRED");
});

test("許可対象外ドメインのアカウントを拒否する", async () => {
  const response = await request(app())
    .get("/api/v2/me")
    .set(identity("person@outside.example"))
    .expect(403);
  assert.equal(response.body.code, "ACCOUNT_NOT_AUTHORIZED");
});

test("依頼者は公開フォームと本人所有レコードの機能を利用できる", async () => {
  const target = app();
  await request(target).get("/api/v2/dashboard").set(identity("person@example.com")).expect(200);
  await request(target).post("/api/v2/documents/preview").set(identity("person@example.com")).expect(200);
  await request(target).get("/api/v2/documents").set(identity("person@example.com")).expect(200);

  const blocked = await request(target)
    .get("/api/v2/matters")
    .set(identity("person@example.com"))
    .expect(403);
  assert.equal(blocked.body.code, "ROLE_FORBIDDEN");
  assert.equal(blocked.body.role, "requester");
});

test("法務担当は文書を参照できるが管理APIを利用できない", async () => {
  const target = app();
  await request(target).get("/api/v2/documents").set(identity("legal@example.com")).expect(200);
  await request(target).get("/api/v2/admin/summary").set(identity("legal@example.com")).expect(403);
});

test("管理者は管理APIを利用できる", async () => {
  const response = await request(app())
    .get("/api/v2/admin/summary")
    .set(identity("admin@example.com"))
    .expect(200);
  assert.equal(response.body.ok, true);
});

test("認証無効モードは既存検証環境を管理者として維持する", async () => {
  const response = await request(app({
    mode: "disabled",
    adminEmails: new Set(),
    legalEmails: new Set(),
    requesterDomains: new Set()
  })).get("/api/v2/admin/summary").expect(200);
  assert.equal(response.body.ok, true);
});
