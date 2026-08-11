import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeIntegrationSettings, type IntegrationValues } from "./runtime-settings.js";
import { MemoryAppSettingsRepository } from "./settings-repository.js";

function env(): IntegrationValues {
  return {
    backlogHost: "env.backlog.jp", backlogProjectKey: "ENV",
    slackLegalConsultChannel: "C0ENV", gmailSenderEmail: "env@example.co.jp",
    gmailInboundMailbox: "", gmailInboundQuery: "q", cloudSignAllowedRecipients: ""
  };
}

test("ランタイム設定: 初期値は env・refresh で app_settings が上書き", async () => {
  const repo = new MemoryAppSettingsRepository({
    BACKLOG_HOST: "db.backlog.jp", CLOUDSIGN_ALLOWED_RECIPIENTS: "a@example.co.jp"
  });
  const rt = new RuntimeIntegrationSettings(env(), repo);
  assert.equal(rt.current().backlogHost, "env.backlog.jp");
  await rt.refresh();
  assert.equal(rt.current().backlogHost, "db.backlog.jp");
  assert.equal(rt.current().cloudSignAllowedRecipients, "a@example.co.jp");
  assert.equal(rt.current().backlogProjectKey, "ENV");   // 未設定キーは env のまま
});

test("ランタイム設定: 保存後の refresh で新値・削除（空）で env に戻る", async () => {
  const repo = new MemoryAppSettingsRepository({});
  const rt = new RuntimeIntegrationSettings(env(), repo);
  await repo.save({ SLACK_LEGAL_CONSULT_CHANNEL: "C0NEW" });
  await rt.refresh();
  assert.equal(rt.current().slackLegalConsultChannel, "C0NEW");
  await repo.save({ SLACK_LEGAL_CONSULT_CHANNEL: "" });
  await rt.refresh();
  assert.equal(rt.current().slackLegalConsultChannel, "C0ENV");   // 空欄＝env フォールバック
});

test("ランタイム設定: リポジトリ障害は現スナップショット維持", async () => {
  let fail = false;
  const repo = new MemoryAppSettingsRepository({ BACKLOG_HOST: "db.backlog.jp" });
  const wrapped = {
    get: (keys: string[]) => {
      if (fail) throw new Error("db down");
      return repo.get(keys);
    },
    save: repo.save.bind(repo)
  };
  const rt = new RuntimeIntegrationSettings(env(), wrapped);
  await rt.refresh();
  assert.equal(rt.current().backlogHost, "db.backlog.jp");
  fail = true;
  await rt.refresh();
  assert.equal(rt.current().backlogHost, "db.backlog.jp");   // 維持
});

test("ランタイム設定: repository なしなら常に env", async () => {
  const rt = new RuntimeIntegrationSettings(env());
  await rt.refresh();
  assert.deepEqual(rt.current(), env());
});
