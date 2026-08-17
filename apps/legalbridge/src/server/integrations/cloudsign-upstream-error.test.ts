import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUpstreamDetail, classifyCloudSignFailure, parseUpstreamBody,
  redactSecrets, toClientError, toLogLine
} from "./cloudsign-upstream-error.js";

test("JSON の code / message を取り出す", () => {
  assert.deepEqual(
    parseUpstreamBody('{"code":"invalid_participant","message":"許可されていないアドレスです"}'),
    { code: "invalid_participant", message: "許可されていないアドレスです" });
  assert.deepEqual(
    parseUpstreamBody('{"error":"invalid_client","error_description":"client_id is unknown"}'),
    { code: "invalid_client", message: "client_id is unknown" });
});

test("JSON でない応答も本文を残す（HTMLエラーページ等）", () => {
  const parsed = parseUpstreamBody("<html><body>Forbidden</body></html>");
  assert.equal(parsed.code, null);
  assert.match(String(parsed.message), /Forbidden/);
  // 長文は切り詰める。
  assert.ok((parseUpstreamBody("x".repeat(2000)).message ?? "").length <= 500);
});

test("空の応答は null で返す", () => {
  assert.deepEqual(parseUpstreamBody(""), { code: null, message: null });
  assert.deepEqual(parseUpstreamBody("   "), { code: null, message: null });
});

test("client_id・アクセストークンは本文から落とす", () => {
  assert.equal(redactSecrets("client_id=abc123def456 is invalid"), "[redacted] is invalid");
  assert.match(redactSecrets('{"access_token": "eyJhbGciOi.J9-x"}'), /\[redacted\]/);
  assert.equal(redactSecrets("Authorization: Bearer eyJhbGciOi_J9"), "Authorization: [redacted]");
  // 秘密が message 経由で漏れないこと（parse も通す）。
  const parsed = parseUpstreamBody('{"message":"client_id=SECRETVALUE not allowed"}');
  assert.doesNotMatch(String(parsed.message), /SECRETVALUE/);
});

test("宛先の拒否は participant として分類する", () => {
  assert.deepEqual(
    classifyCloudSignFailure({ status: 400, upstreamCode: "invalid_participant", upstreamMessage: null }),
    { kind: "CLOUDSIGN_PARTICIPANT_REJECTED", retryable: false });
  assert.deepEqual(
    classifyCloudSignFailure({ status: 422, upstreamCode: null, upstreamMessage: "許可されていない宛先です" }),
    { kind: "CLOUDSIGN_PARTICIPANT_REJECTED", retryable: false });
});

test("IP 制限と断定するのは IP を示す語があるときだけ", () => {
  // 「アドレス」だけでは宛先と区別できないので IP 扱いにしない（IP対策を先行させない）。
  assert.equal(
    classifyCloudSignFailure({ status: 403, upstreamCode: null, upstreamMessage: "許可されていないアドレスです" }).kind,
    "CLOUDSIGN_PARTICIPANT_REJECTED");
  assert.equal(
    classifyCloudSignFailure({ status: 403, upstreamCode: null, upstreamMessage: "接続元IPが許可されていません" }).kind,
    "CLOUDSIGN_IP_RESTRICTED");
  assert.equal(
    classifyCloudSignFailure({ status: 403, upstreamCode: "ip_restricted", upstreamMessage: null }).kind,
    "CLOUDSIGN_IP_RESTRICTED");
});

test("認証・レート制限・サーバ側障害を分ける", () => {
  assert.equal(
    classifyCloudSignFailure({ status: 401, upstreamCode: null, upstreamMessage: null }).kind,
    "CLOUDSIGN_AUTHENTICATION_FAILED");
  assert.equal(
    classifyCloudSignFailure({ status: 403, upstreamCode: null, upstreamMessage: null }).kind,
    "CLOUDSIGN_AUTHENTICATION_FAILED");
  assert.deepEqual(
    classifyCloudSignFailure({ status: 429, upstreamCode: null, upstreamMessage: null }),
    { kind: "CLOUDSIGN_RATE_LIMITED", retryable: true });
  assert.deepEqual(
    classifyCloudSignFailure({ status: 503, upstreamCode: null, upstreamMessage: null }),
    { kind: "CLOUDSIGN_UPSTREAM_ERROR", retryable: true });
  assert.equal(
    classifyCloudSignFailure({ status: 400, upstreamCode: null, upstreamMessage: "title is required" }).kind,
    "CLOUDSIGN_INVALID_REQUEST");
});

test("detail は method / path / 分類をまとめて持つ", () => {
  const detail = buildUpstreamDetail({
    status: 400, method: "POST", path: "/documents/abc/participants",
    body: '{"code":"invalid_participant","message":"許可されていない宛先です: x@example.com"}'
  });
  assert.equal(detail.status, 400);
  assert.equal(detail.method, "POST");
  assert.equal(detail.path, "/documents/abc/participants");
  assert.equal(detail.upstreamCode, "invalid_participant");
  assert.equal(detail.kind, "CLOUDSIGN_PARTICIPANT_REJECTED");
  assert.equal(detail.retryable, false);
});

test("UI へは分類・対処・CloudSignの一文だけを返す", () => {
  const detail = buildUpstreamDetail({
    status: 400, method: "POST", path: "/documents/abc/participants",
    body: '{"code":"invalid_participant","message":"許可されていない宛先です: x@example.com"}'
  });
  const client = toClientError(detail);
  assert.equal(client.code, "CLOUDSIGN_PARTICIPANT_REJECTED");
  assert.match(client.error, /メールアドレスを確認/);
  assert.equal(client.retryable, false);
  assert.match(String(client.upstreamMessage), /x@example.com/);
  // path / status など内部情報は UI へ出さない。
  assert.equal("path" in client, false);
  assert.equal("status" in client, false);
});

test("ログ1行に秘密を含めない", () => {
  const detail = buildUpstreamDetail({
    status: 401, method: "POST", path: "/token",
    body: '{"error":"invalid_client","error_description":"client_id=SECRETVALUE is unknown"}'
  });
  const line = toLogLine(detail);
  assert.match(line, /POST \/token/);
  assert.match(line, /status=401/);
  assert.match(line, /kind=CLOUDSIGN_AUTHENTICATION_FAILED/);
  assert.doesNotMatch(line, /SECRETVALUE/);
});

test("IPアドレスと書かれていれば宛先語が混ざっても IP 制限と読む", () => {
  assert.equal(
    classifyCloudSignFailure({ status: 403, upstreamCode: null, upstreamMessage: "IPアドレスが許可されていません" }).kind,
    "CLOUDSIGN_IP_RESTRICTED");
  // 宛先そのものを指す語が併記されていれば宛先側（IP対策へ先走らない）。
  assert.equal(
    classifyCloudSignFailure({ status: 403, upstreamCode: null,
      upstreamMessage: "宛先のメールアドレスが許可されていません（送信元IP不問）" }).kind,
    "CLOUDSIGN_PARTICIPANT_REJECTED");
});

test("401 は宛先文言があっても認証エラーとして扱う", () => {
  assert.equal(
    classifyCloudSignFailure({ status: 401, upstreamCode: null, upstreamMessage: "アドレスが不正です" }).kind,
    "CLOUDSIGN_AUTHENTICATION_FAILED");
});
