import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySlackSignature, SLACK_SIGNATURE_WINDOW_SECONDS } from "./signature.js";

const sign = (secret: string, ts: string, body: string) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

test("正しい署名は通る", () => {
  const body = "command=%2F法務依頼&trigger_id=t1";
  assert.equal(verifySlackSignature({
    signingSecret: "s3cret", timestampHeader: "1700000000",
    signatureHeader: sign("s3cret", "1700000000", body),
    rawBody: body, nowSeconds: 1700000000
  }), true);
});

test("署名シークレット未設定は常に拒否（fail-closed）", () => {
  assert.equal(verifySlackSignature({
    signingSecret: "", timestampHeader: "1700000000",
    signatureHeader: sign("s3cret", "1700000000", "x"), rawBody: "x", nowSeconds: 1700000000
  }), false);
});

test("リプレイ窓を外れた要求は拒否", () => {
  const body = "x";
  const ts = "1700000000";
  const sig = sign("s3cret", ts, body);
  const late = 1700000000 + SLACK_SIGNATURE_WINDOW_SECONDS + 1;
  assert.equal(verifySlackSignature({
    signingSecret: "s3cret", timestampHeader: ts, signatureHeader: sig, rawBody: body, nowSeconds: late
  }), false);
});

test("本文が改竄されていれば拒否", () => {
  assert.equal(verifySlackSignature({
    signingSecret: "s3cret", timestampHeader: "1700000000",
    signatureHeader: sign("s3cret", "1700000000", "original"),
    rawBody: "tampered", nowSeconds: 1700000000
  }), false);
});
