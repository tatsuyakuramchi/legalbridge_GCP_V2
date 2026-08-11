import assert from "node:assert/strict";
import test from "node:test";
import {
  applyIntegrationOverrides, loadIntegrationOverrides, type IntegrationOverridableConfig
} from "./integration-overrides.js";
import { MemoryAppSettingsRepository, type AppSettingsRepository } from "./settings-repository.js";

function baseConfig(): IntegrationOverridableConfig {
  return {
    backlogHost: "env.backlog.jp",
    backlogProjectKey: "ENV",
    slackLegalConsultChannel: "C0ENV",
    gmailSenderEmail: "env@example.co.jp",
    gmailInboundMailbox: "",
    gmailInboundQuery: "has:attachment",
    cloudSignAllowedRecipients: ""
  };
}

test("連携上書き: 非空の設定値だけが env を上書き（空欄・空白はフォールバック）", () => {
  const config = baseConfig();
  const applied = applyIntegrationOverrides(config, {
    BACKLOG_HOST: "db.backlog.jp",
    BACKLOG_PROJECT_KEY: "  ",              // 空白のみ → env のまま
    CLOUDSIGN_ALLOWED_RECIPIENTS: "a@example.co.jp,b@example.co.jp"
  });
  assert.deepEqual(applied.sort(), ["BACKLOG_HOST", "CLOUDSIGN_ALLOWED_RECIPIENTS"]);
  assert.equal(config.backlogHost, "db.backlog.jp");
  assert.equal(config.backlogProjectKey, "ENV");
  assert.equal(config.cloudSignAllowedRecipients, "a@example.co.jp,b@example.co.jp");
  assert.equal(config.gmailSenderEmail, "env@example.co.jp");
});

test("連携上書き: 設定なしなら何も変えない", () => {
  const config = baseConfig();
  assert.deepEqual(applyIntegrationOverrides(config, {}), []);
  assert.deepEqual(config, baseConfig());
});

test("連携上書き: ロード失敗は空（env フォールバック・起動を止めない）", async () => {
  const broken: AppSettingsRepository = {
    get: async () => { throw new Error("db down"); },
    save: async () => 0
  };
  assert.deepEqual(await loadIntegrationOverrides(broken), {});
  const ok = new MemoryAppSettingsRepository({ BACKLOG_HOST: "db.backlog.jp", COMPANY_NAME: "無関係" });
  const values = await loadIntegrationOverrides(ok);
  assert.equal(values.BACKLOG_HOST, "db.backlog.jp");
  assert.equal(values.COMPANY_NAME, undefined);   // 連携キー以外は読まない
});
