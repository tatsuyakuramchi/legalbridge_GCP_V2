import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createAdminRouter } from "./routes.js";
import { MemoryAdminRepository } from "./repository.js";
import { MemoryMatterRepository } from "../matters/repository.js";
import { MemorySlackNotificationHistoryRepository } from "../integrations/slack-history-repository.js";
import { MemorySlackNotificationApprovalRepository } from "../integrations/slack-approval-repository.js";
import { createSlackRecipientDirectory } from "../integrations/slack-recipient-resolver.js";
import {
  MemorySlackDeliveryAdapter,
  DisabledSlackDeliveryAdapter
} from "../integrations/slack-delivery-adapter.js";

const fingerprint = "a".repeat(64);

function appFor(options: {
  enabled: boolean;
  adapterConfigured?: boolean;
}) {
  const adapter = options.adapterConfigured === false
    ? new DisabledSlackDeliveryAdapter()
    : new MemorySlackDeliveryAdapter();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = {
      email: "admin@arclight.co.jp",
      subject: "test",
      role: "admin",
      source: "disabled"
    };
    next();
  });
  app.use("/api/v2", createAdminRouter(
    new MemoryAdminRepository(),
    new MemoryMatterRepository([]),
    new MemorySlackNotificationHistoryRepository(),
    new MemorySlackNotificationApprovalRepository(),
    createSlackRecipientDirectory(""),
    { integrationMode: "live", slackCapabilityEnabled: true, adapterConfigured: true },
    false,
    { adapter, enabled: options.enabled }
  ));
  return app;
}

test("配信ゲート無効時はSlack送信を拒否する", async () => {
  const response = await request(appFor({ enabled: false }))
    .post("/api/v2/admin/slack-notifications/dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", issueKey: "LEGAL-1", fingerprint });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "SLACK_DISPATCH_DISABLED");
});

test("アダプタ未接続時はSlack送信を拒否する", async () => {
  const response = await request(appFor({ enabled: true, adapterConfigured: false }))
    .post("/api/v2/admin/slack-notifications/dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", issueKey: "LEGAL-1", fingerprint });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "SLACK_DISPATCH_DISABLED");
});

test("検証確認文字列がなければSlack送信しない", async () => {
  const response = await request(appFor({ enabled: true }))
    .post("/api/v2/admin/slack-notifications/dispatch")
    .send({ issueKey: "LEGAL-1", fingerprint });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "SLACK_DISPATCH_CONFIRMATION_REQUIRED");
});

test("不正な課題キー・指紋を拒否する", async () => {
  const response = await request(appFor({ enabled: true }))
    .post("/api/v2/admin/slack-notifications/dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", issueKey: "invalid", fingerprint: "xyz" });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "SLACK_DISPATCH_INVALID");
});

test("対象通知が見つからなければ送信せず409を返す", async () => {
  const response = await request(appFor({ enabled: true }))
    .post("/api/v2/admin/slack-notifications/dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", issueKey: "LEGAL-999", fingerprint });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "SLACK_DISPATCH_STALE");
});

test("検証送信は配信ゲート無効時に拒否する", async () => {
  const response = await request(appFor({ enabled: false }))
    .post("/api/v2/admin/slack-notifications/test-dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", userId: "U01234567" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "SLACK_DISPATCH_DISABLED");
});

test("検証送信は不正なSlackユーザーIDを拒否する", async () => {
  const response = await request(appFor({ enabled: true }))
    .post("/api/v2/admin/slack-notifications/test-dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", userId: "not-a-user" });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "SLACK_DISPATCH_INVALID_USER");
});

test("検証送信は有効なユーザーへ固定メッセージをDMする", async () => {
  const response = await request(appFor({ enabled: true }))
    .post("/api/v2/admin/slack-notifications/test-dispatch")
    .send({ confirmation: "SEND_SLACK_VALIDATION", userId: "U01234567" });
  assert.equal(response.status, 201);
  assert.equal(response.body.externalSend, true);
  assert.match(response.body.receipt.channelId, /^[A-Z0-9]+$/);
});
