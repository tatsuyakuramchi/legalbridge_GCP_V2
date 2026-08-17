import assert from "node:assert/strict";
import test from "node:test";
import { describeHttpFailure, readJsonResponse } from "./http.js";

test("アプリが返す JSON のエラー文をそのまま使う", () => {
  assert.equal(
    describeHttpFailure(422, JSON.stringify({ error: "テンプレートが見つかりません" }), "既定"),
    "テンプレートが見つかりません");
});

test("JSON でない 503 でも何が起きたか分かる文にする", () => {
  // 実際に画面へ出ていた文字列は
  //   Unexpected token 'S', "Service Unavailable" is not valid JSON
  // で、利用者には原因も対処も分からなかった。
  const message = describeHttpFailure(503, "Service Unavailable", "Driveへの保存に失敗しました。");
  assert.match(message, /^Driveへの保存に失敗しました。/);
  assert.match(message, /再実行/);
  assert.match(message, /HTTP 503/);
  assert.doesNotMatch(message, /valid JSON|Unexpected token/);
});

test("502・504 も一時的な不調として案内する", () => {
  for (const status of [502, 504]) {
    assert.match(describeHttpFailure(status, "Bad Gateway", "失敗しました。"), /再実行/);
  }
});

test("401・403 は再読み込みを案内する", () => {
  assert.match(describeHttpFailure(403, "Forbidden", "失敗しました。"), /再読み込み/);
  assert.match(describeHttpFailure(401, "", "失敗しました。"), /再読み込み/);
});

test("HTML のエラーページでも本文を貼り付けない", () => {
  const message = describeHttpFailure(500, "<html><body>Internal Server Error</body></html>", "失敗しました。");
  assert.equal(message, "失敗しました。（HTTP 500）");
});

test("JSON だがエラー文が無い場合は既定文＋状態コード", () => {
  assert.equal(describeHttpFailure(500, JSON.stringify({ code: "X" }), "失敗しました。"),
    "失敗しました。（HTTP 500）");
  assert.equal(describeHttpFailure(500, JSON.stringify({ error: "  " }), "失敗しました。"),
    "失敗しました。（HTTP 500）");
  assert.equal(describeHttpFailure(500, "", "失敗しました。"), "失敗しました。（HTTP 500）");
});

// ── 応答の読み取り ───────────────────────────────────────────────────
const responseOf = (status: number, body: string): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body } as Response);

test("成功時は JSON を返す", async () => {
  const result = await readJsonResponse<{ driveLink: string }>(
    responseOf(200, JSON.stringify({ driveLink: "https://drive/x" })), "失敗しました。");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.driveLink, "https://drive/x");
});

test("本文が空の成功応答でも例外にしない（204 など）", async () => {
  const result = await readJsonResponse(responseOf(204, ""), "失敗しました。");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data, undefined);
});

test("JSON でない失敗応答でも例外にせず message を返す", async () => {
  const result = await readJsonResponse(responseOf(503, "Service Unavailable"), "Driveへの保存に失敗しました。");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 503);
  assert.match(result.ok === false ? result.message : "", /Driveへの保存に失敗しました。/);
});

test("失敗応答の JSON 本体も参照できる（409 の current など）", async () => {
  const result = await readJsonResponse(
    responseOf(409, JSON.stringify({ error: "衝突", current: { id: 3 } })), "失敗しました。");
  assert.equal(result.ok === false && result.message, "衝突");
  assert.deepEqual(result.ok === false ? (result.data as { current: unknown }).current : null, { id: 3 });
});
