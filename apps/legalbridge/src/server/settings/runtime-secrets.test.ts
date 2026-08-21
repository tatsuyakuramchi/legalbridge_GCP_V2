import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeSecrets } from "./runtime-secrets.js";
import { MemorySecretStore } from "./secret-store.js";

// 秘密情報のランタイム解決（Phase 2-5）。env フォールバック・Secret Manager 上書き・保存時反映の検証。

const ENV = {
  BACKLOG_API_KEY: "env-backlog-key",
  SLACK_BOT_TOKEN: "xoxb-env",
  SLACK_SIGNING_SECRET: "env-signing",
  CLOUDSIGN_CLIENT_ID: "env-client-id",
  CLOUDSIGN_WEBHOOK_TOKEN: "env-cs-token",
  BACKLOG_WEBHOOK_TOKEN: "env-bl-token",
  JOBS_TRIGGER_TOKEN: "env-jobs-token",
  LB_PORTAL_SECRET: "env-portal-secret"
};

test("runtime-secrets: ストア未設定なら常に env の値", async () => {
  const secrets = new RuntimeSecrets(ENV);
  assert.equal(secrets.get("BACKLOG_API_KEY"), "env-backlog-key");
  await secrets.refresh();   // no-op
  assert.equal(secrets.get("SLACK_BOT_TOKEN"), "xoxb-env");
});

test("runtime-secrets: Secret Manager の値が env を上書きし、無いキーは env のまま", async () => {
  const store = new MemorySecretStore();
  await store.addVersion("backlog-api-key", "sm-backlog-key");
  const secrets = new RuntimeSecrets(ENV, store);
  await secrets.refresh();
  assert.equal(secrets.get("BACKLOG_API_KEY"), "sm-backlog-key");
  assert.equal(secrets.get("SLACK_BOT_TOKEN"), "xoxb-env");   // SM に無い → env
});

test("runtime-secrets: 保存（新しい版）→ refresh で最新値", async () => {
  const store = new MemorySecretStore();
  await store.addVersion("SLACK_BOT_TOKEN", "xoxb-old");
  const secrets = new RuntimeSecrets(ENV, store);
  await secrets.refresh();
  assert.equal(secrets.get("SLACK_BOT_TOKEN"), "xoxb-old");
  await store.addVersion("SLACK_BOT_TOKEN", "xoxb-new");
  await secrets.refresh();
  assert.equal(secrets.get("SLACK_BOT_TOKEN"), "xoxb-new");
});

test("runtime-secrets: ストア障害時は現行スナップショットを維持", async () => {
  const store = new MemorySecretStore();
  await store.addVersion("cloudsign-client-id", "sm-client-id");
  const secrets = new RuntimeSecrets(ENV, store);
  await secrets.refresh();
  assert.equal(secrets.get("CLOUDSIGN_CLIENT_ID"), "sm-client-id");
  const broken = store as unknown as { access: () => Promise<string | null> };
  broken.access = async () => { throw new Error("unavailable"); };
  await secrets.refresh();
  assert.equal(secrets.get("CLOUDSIGN_CLIENT_ID"), "sm-client-id");
});

test("runtime-secrets: 空文字・空白のみの版は無視して env フォールバック", async () => {
  const store = new MemorySecretStore();
  await store.addVersion("JOBS_TRIGGER_TOKEN", "   ");
  const secrets = new RuntimeSecrets(ENV, store);
  await secrets.refresh();
  assert.equal(secrets.get("JOBS_TRIGGER_TOKEN"), "env-jobs-token");
});
