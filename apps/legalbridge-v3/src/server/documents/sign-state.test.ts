import test from "node:test";
import assert from "node:assert/strict";
import { signStateOf, signStateSql, UNSENT } from "./sign-state.js";

test("記録が無ければ未送信", () => {
  assert.deepEqual(signStateOf(null), UNSENT);
  assert.deepEqual(signStateOf(undefined), UNSENT);
  assert.deepEqual(signStateOf(""), UNSENT);
  assert.deepEqual(signStateOf({ status: "unsent", at: "2026-09-20", source: "manual" }), UNSENT);
  assert.deepEqual(signStateOf({ status: "weird" }), UNSENT);
});

test("jsonb のオブジェクトでも JSON 文字列でも読める。日付は日まで", () => {
  const want = { status: "executed", at: "2026-09-12", source: "manual" };
  assert.deepEqual(signStateOf({ status: "executed", at: "2026-09-12", source: "manual" }), want);
  assert.deepEqual(signStateOf(JSON.stringify({ status: "executed", at: "2026-09-12T12:00:00", source: "manual" })), want);
  assert.deepEqual(signStateOf({ status: "sent", at: "2026-09-10", source: "cloudsign" }),
    { status: "sent", at: "2026-09-10", source: "cloudsign" });
  assert.deepEqual(signStateOf({ status: "terminated", at: null, source: "x" }),
    { status: "terminated", at: null, source: null });
});

test("副問い合わせは文書への記録だけを見て、いちばん新しいものを採る", () => {
  const sql = signStateSql("d.id");
  assert.match(sql, /a\.target_type = 'document' AND a\.target_id = d\.id/);
  assert.match(sql, /a\.action = 'cloudsign\.send'/);
  assert.match(sql, /'cloudsign\.applied'/);
  assert.match(sql, /ORDER BY a\.occurred_at DESC, a\.id DESC/);
  assert.ok(!sql.includes("gmail.send"), "メールで送ったのは CloudSign の状態ではない");
});
