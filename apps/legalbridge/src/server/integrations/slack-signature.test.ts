import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "./slack-signature.js";

const SECRET = "test-signing-secret";
function sign(ts: string, body: string, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
}

test("slack署名: 正しい署名は通る", () => {
  const body = "command=%2F法務依頼&trigger_id=t1";
  assert.equal(verifySlackSignature({
    signingSecret: SECRET, timestampHeader: "1000", signatureHeader: sign("1000", body),
    rawBody: body, nowSeconds: 1000
  }), true);
});

test("slack署名: secret 未設定は常に拒否（fail-closed・V1 の fail-open を踏襲しない）", () => {
  const body = "x=1";
  assert.equal(verifySlackSignature({
    signingSecret: "", timestampHeader: "1000", signatureHeader: sign("1000", body),
    rawBody: body, nowSeconds: 1000
  }), false);
});

test("slack署名: 改竄ボディ・別secret・接頭辞なしは拒否", () => {
  const body = "x=1";
  const ok = { signingSecret: SECRET, timestampHeader: "1000", nowSeconds: 1000 };
  assert.equal(verifySlackSignature({ ...ok, signatureHeader: sign("1000", body), rawBody: "x=2" }), false);
  assert.equal(verifySlackSignature({ ...ok, signatureHeader: sign("1000", body, "other"), rawBody: body }), false);
  assert.equal(verifySlackSignature({ ...ok, signatureHeader: sign("1000", body).slice(3), rawBody: body }), false);
});

test("slack署名: リプレイ窓（300秒）超過は拒否", () => {
  const body = "x=1";
  assert.equal(verifySlackSignature({
    signingSecret: SECRET, timestampHeader: "1000", signatureHeader: sign("1000", body),
    rawBody: body, nowSeconds: 1301
  }), false);
  assert.equal(verifySlackSignature({
    signingSecret: SECRET, timestampHeader: "1000", signatureHeader: sign("1000", body),
    rawBody: body, nowSeconds: 1300
  }), true);
});
