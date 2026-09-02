import assert from "node:assert/strict";
import test from "node:test";
import { PgRecipientSuggestionSource } from "./send-history-routes.js";
import type { DatabasePool } from "../db/pool.js";

// 宛先候補（067）: 署名者用（電子契約）→ 取引先担当者 → 代表メールの順で出し分け、
// 同一アドレスは先勝ちで1件に寄せる。

function poolWith(rows: Array<Record<string, unknown>>): DatabasePool {
  return { query: async () => ({ rows }) } as unknown as DatabasePool;
}

test("宛先候補は署名者・担当者・代表メールを出し分ける", async () => {
  const source = new PgRecipientSuggestionSource(poolWith([{
    email: "info@example.co.jp",
    contact_email: "tantou@example.co.jp",
    signer_email: "sign@example.co.jp",
    name: "山田 太郎"
  }]));
  const suggestions = await source.suggest(1);
  assert.deepEqual(suggestions, [
    { email: "sign@example.co.jp", name: "山田 太郎", source: "署名者用（電子契約）" },
    { email: "tantou@example.co.jp", name: "山田 太郎", source: "取引先担当者" },
    { email: "info@example.co.jp", name: "山田 太郎", source: "取引先マスタ" }
  ]);
});

test("宛先候補は同一アドレスを重複させず、@なし・空欄は除外する", async () => {
  const source = new PgRecipientSuggestionSource(poolWith([{
    email: "TANTOU@example.co.jp",   // 担当者と大文字小文字違いの同一アドレス
    contact_email: "tantou@example.co.jp",
    signer_email: "",                 // 未設定
    name: "スタジオ雨宿り"
  }]));
  const suggestions = await source.suggest(1);
  assert.deepEqual(suggestions, [
    { email: "tantou@example.co.jp", name: "スタジオ雨宿り", source: "取引先担当者" }
  ]);
});
