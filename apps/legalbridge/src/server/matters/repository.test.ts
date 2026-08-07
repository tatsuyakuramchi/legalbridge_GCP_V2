import assert from "node:assert/strict";
import test from "node:test";
import { optionalEmail } from "./repository.js";

// 回帰テスト：旧実装は正規表現リテラルを二重エスケープ(\\s/\\.)しており、
// 全ての正当なメールを null にしていた。これが Slack候補フローで依頼者宛先が
// 常に unmapped/missing になる原因だった。
test("正当なメールをそのまま返す（二重エスケープ回帰）", () => {
  assert.equal(optionalEmail("a@b.com"), "a@b.com");
  assert.equal(optionalEmail("user@example.co.jp"), "user@example.co.jp");
});

test("大文字・前後空白は正規化する", () => {
  assert.equal(optionalEmail("  User@Example.COM  "), "user@example.com");
});

test("空・非メール・null は null", () => {
  assert.equal(optionalEmail(""), null);
  assert.equal(optionalEmail(null), null);
  assert.equal(optionalEmail("not-an-email"), null);
  assert.equal(optionalEmail("missing-domain@"), null);
});
