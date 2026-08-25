import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  DEFAULT_EMAIL_TEMPLATES, applyEmailTokens, cleanupRenderedBody, mergeCc, loadEmailSettings
} from "./email-settings.js";
import { createEmailSettingsRouter } from "./email-settings-routes.js";
import { MemoryAppSettingsRepository } from "./settings-repository.js";
import type { GmailDeliveryAdapter, GmailDeliveryRequest } from "../integrations/gmail-delivery-adapter.js";
import { GmailApiError } from "../integrations/gmail-api-adapter.js";
import { buildFinalizeNotification } from "../documents/gmail-notification-routes.js";
import type { RegisteredDocument } from "../documents/registry-repository.js";

test("email-settings: トークン置換と空値行の削除", () => {
  const body = applyEmailTokens("A{{vendorName}}B\n■ 検収金額：{{amount}}\n文書URL：{{link}}\nTEL：{{companyTel}}",
    { vendorName: "甲", amount: "", link: "", companyTel: "" });
  // 空値になった ■/URL/TEL の行は落ちる
  assert.equal(cleanupRenderedBody(body), "A甲B");
  // 未知トークンは置換されず残る（打ち間違いに気づける）
  assert.equal(applyEmailTokens("X{{unknownToken}}Y", { vendorName: "甲" }), "X{{unknownToken}}Y");
});

test("email-settings: 既定CCと都度CCのマージ（重複・宛先かぶり除外）", () => {
  const merged = mergeCc("keiri@x.jp, boss@x.jp", "boss@x.jp, extra@x.jp", ["keiri@x.jp"]);
  assert.deepEqual(merged, ["boss@x.jp", "extra@x.jp"]);
});

test("email-settings: 設定が空なら既定テンプレート・カスタムがあれば上書き", async () => {
  const empty = await loadEmailSettings(new MemoryAppSettingsRepository({}));
  assert.equal(empty.templates.general.subject, DEFAULT_EMAIL_TEMPLATES.general.subject);
  const custom = await loadEmailSettings(new MemoryAppSettingsRepository({
    email_subject_general: "カスタム件名（{{documentNumber}}）", email_cc: "cc@x.jp"
  }));
  assert.equal(custom.templates.general.subject, "カスタム件名（{{documentNumber}}）");
  assert.equal(custom.templates.general.body, DEFAULT_EMAIL_TEMPLATES.general.body);
  assert.equal(custom.cc, "cc@x.jp");
  // V1 の既定CCは大文字キー（EMAIL_CC）。email_cc 未保存の間はこれを読む。
  const v1 = await loadEmailSettings(new MemoryAppSettingsRepository({ EMAIL_CC: "keiri@x.jp" }));
  assert.equal(v1.cc, "keiri@x.jp");
  const both = await loadEmailSettings(new MemoryAppSettingsRepository({
    EMAIL_CC: "keiri@x.jp", email_cc: "new@x.jp"
  }));
  assert.equal(both.cc, "new@x.jp");
});

test("email-settings: カスタム文面が送付メールに反映される", () => {
  const doc: RegisteredDocument = {
    id: 1, documentNumber: "DOC-1", issueKey: "LB-1", templateType: "license",
    templateVersionId: 1, title: "契約", counterparty: "甲社",
    driveLink: "", createdAt: "2026-08-21T00:00:00.000Z", createdBy: null, formData: {}
  };
  const templates = {
    ...DEFAULT_EMAIL_TEMPLATES,
    general: { subject: "件名 {{documentNumber}}", body: "{{vendorName}}様\n{{deliveryMethod}}です" }
  };
  const content = buildFinalizeNotification(doc, "to@x.jp", { attached: true, templates });
  assert.equal(content.subject, "件名 DOC-1");
  assert.equal(content.bodyText, "甲社様\n添付のとおりです");
});

class CapturingAdapter implements GmailDeliveryAdapter {
  readonly configured = true;
  sent: GmailDeliveryRequest | null = null;
  async send(req: GmailDeliveryRequest) { this.sent = req; return { messageId: "m1", threadId: null }; }
}

function appFor(options: { role?: string; live?: boolean; writeEnabled?: boolean; store?: Record<string, string> } = {}) {
  const repository = new MemoryAppSettingsRepository(options.store ?? {});
  const adapter = new CapturingAdapter();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "a@x.jp", subject: "s", role: options.role ?? "admin", source: "disabled" } as never;
    next();
  });
  app.use("/api/v2", createEmailSettingsRouter({
    repository, writeEnabled: options.writeEnabled ?? true,
    gmail: adapter,
    gateSettings: {
      integrationMode: options.live ? "live" : "local",
      gmailCapabilityEnabled: options.live ?? false,
      adapterConfigured: true, senderEmail: "legal@x.jp"
    }
  }));
  return { app, repository, adapter };
}

test("email-settings routes: 読取は admin のみ・既定とトークン一覧を返す", async () => {
  const { app } = appFor();
  const ok = await request(app).get("/api/v2/email-settings");
  assert.equal(ok.status, 200);
  assert.ok(ok.body.defaults.inspection.subject.includes("検収書"));
  assert.ok(Array.isArray(ok.body.tokens) && ok.body.tokens.length >= 8);
  const denied = await request(appFor({ role: "legal" }).app).get("/api/v2/email-settings");
  assert.equal(denied.status, 403);
});

test("email-settings routes: 保存は既定と同じ内容を空欄として格納（既定追従）", async () => {
  const { app, repository } = appFor();
  const response = await request(app).post("/api/v2/email-settings").send({
    cc: "keiri@x.jp",
    templates: {
      inspection: DEFAULT_EMAIL_TEMPLATES.inspection,
      royalty: DEFAULT_EMAIL_TEMPLATES.royalty,
      general: { subject: "カスタム（{{documentNumber}}）", body: "本文 {{vendorName}}" }
    }
  });
  assert.equal(response.status, 200);
  const stored = await repository.get(["email_cc", "email_subject_inspection", "email_subject_general", "email_body_general"]);
  assert.equal(stored.email_cc, "keiri@x.jp");
  assert.equal(stored.email_subject_inspection, "");           // 既定と同じ＝空欄
  assert.equal(stored.email_subject_general, "カスタム（{{documentNumber}}）");
  assert.equal(stored.email_body_general, "本文 {{vendorName}}");
});

test("email-settings routes: Gmail API の失敗は理由文つきの502で返す", async () => {
  class FailingAdapter implements GmailDeliveryAdapter {
    readonly configured = true;
    async send(): Promise<never> {
      throw new GmailApiError("Gmail API HTTP error: 400 — Invalid To header", "http_error", 400);
    }
  }
  const repository = new MemoryAppSettingsRepository({});
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "a@x.jp", subject: "s", role: "admin", source: "disabled" } as never;
    next();
  });
  app.use("/api/v2", createEmailSettingsRouter({
    repository, writeEnabled: true, gmail: new FailingAdapter(),
    gateSettings: {
      integrationMode: "live", gmailCapabilityEnabled: true,
      adapterConfigured: true, senderEmail: "legal@x.jp"
    }
  }));
  const response = await request(app).post("/api/v2/email-settings/test")
    .send({ to: "me@x.jp", kind: "general" });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /Invalid To header/);
});

test("email-settings routes: テスト送信は件名に【テスト送信】・ローカルは409", async () => {
  const live = appFor({ live: true });
  const sent = await request(live.app).post("/api/v2/email-settings/test")
    .send({ to: "me@x.jp", kind: "inspection" });
  assert.equal(sent.status, 201);
  assert.match(String(live.adapter.sent?.subject), /^【テスト送信】/);
  assert.match(String(live.adapter.sent?.bodyText), /テスト送信です/);

  const local = appFor({ live: false });
  const blocked = await request(local.app).post("/api/v2/email-settings/test")
    .send({ to: "me@x.jp", kind: "general" });
  assert.equal(blocked.status, 409);
  assert.ok(Array.isArray(blocked.body.blockers));
});
