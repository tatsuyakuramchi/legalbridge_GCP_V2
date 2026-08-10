import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMPANY_PROFILE, loadCompanyProfile } from "./company-profile.js";
import { MemoryAppSettingsRepository, type AppSettingsRepository } from "./settings-repository.js";
import { PgMasterDataRepository } from "../master-data/repository.js";
import type { DatabasePool } from "../db/pool.js";

test("会社プロファイル: settings 未注入は既定（従来ハードコード値）", async () => {
  const profile = await loadCompanyProfile(undefined);
  assert.equal(profile.name, "株式会社アークライト");
  assert.equal(profile.address, "東京都千代田区神田小川町1-2 風雲堂ビル2階");
  assert.equal(profile.rep, "代表取締役　青柳 昌行");
  assert.equal(profile.invoiceNo, "");
});

test("会社プロファイル: app_settings の値が既定を上書き（空値は既定を維持）", async () => {
  const settings = new MemoryAppSettingsRepository({
    COMPANY_NAME: "新社名株式会社",
    COMPANY_INVOICE_NO: "T1234567890123",
    COMPANY_TEL: "03-0000-0000",
    COMPANY_ADDRESS: "  "   // 空白のみは未設定扱い
  });
  const profile = await loadCompanyProfile(settings);
  assert.equal(profile.name, "新社名株式会社");
  assert.equal(profile.invoiceNo, "T1234567890123");
  assert.equal(profile.tel, "03-0000-0000");
  assert.equal(profile.address, DEFAULT_COMPANY_PROFILE.address);   // 既定へ縮退
  assert.equal(profile.rep, DEFAULT_COMPANY_PROFILE.rep);
});

test("会社プロファイル: 読取失敗（権限未整備等）は既定へ縮退", async () => {
  const broken: AppSettingsRepository = {
    get: async () => { const e = new Error("permission denied"); (e as { code?: string }).code = "42501"; throw e; },
    save: async () => 0
  };
  const profile = await loadCompanyProfile(broken);
  assert.deepEqual(profile, DEFAULT_COMPANY_PROFILE);
});

test("マスタ差込: company タイプは app_settings 由来の値を返す", async () => {
  const settings = new MemoryAppSettingsRepository({
    COMPANY_NAME: "新社名株式会社",
    COMPANY_BANK_INFO: "〇〇銀行 本店 普通 1234567"
  });
  // company 分岐は DB を触らないためダミープールで良い。
  const dummyPool = { query: async () => { throw new Error("should not query"); } } as unknown as DatabasePool;
  const repository = new PgMasterDataRepository(dummyPool, settings);
  const items = await repository.search("company", "");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "新社名株式会社");
  assert.equal(items[0].values.name, "新社名株式会社");
  assert.equal(items[0].values.bank_info, "〇〇銀行 本店 普通 1234567");
  assert.equal(items[0].values.address, DEFAULT_COMPANY_PROFILE.address);
});

test("マスタ差込: settings 未注入でも従来値で動く", async () => {
  const dummyPool = { query: async () => { throw new Error("should not query"); } } as unknown as DatabasePool;
  const repository = new PgMasterDataRepository(dummyPool);
  const items = await repository.search("company", "");
  assert.equal(items[0].values.name, "株式会社アークライト");
  assert.equal(items[0].values.rep, "代表取締役　青柳 昌行");
});
