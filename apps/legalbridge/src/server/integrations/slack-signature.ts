import { createHmac, timingSafeEqual } from "node:crypto";

// Slack リクエスト署名検証（Phase 16-3）。v0 スキーム：HMAC-SHA256("v0:{ts}:{rawBody}")。
// V1（slackGateway.ts）は signing secret 未設定時に素通し（fail-open）だったが、
// V2 は **未設定＝常に拒否（fail-closed）** とする。リプレイ窓は 300 秒。

export const SLACK_SIGNATURE_WINDOW_SECONDS = 300;

export function verifySlackSignature(input: {
  signingSecret: string | undefined | null;
  timestampHeader: string | undefined | null;   // x-slack-request-timestamp
  signatureHeader: string | undefined | null;   // x-slack-signature（"v0=..."）
  rawBody: string | Buffer;
  nowSeconds?: number;                          // テスト用の現在時刻（省略時は実時刻）
}): boolean {
  const secret = String(input.signingSecret ?? "");
  if (!secret) return false;   // fail-closed

  const ts = String(input.timestampHeader ?? "").trim();
  if (!/^\d+$/.test(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > SLACK_SIGNATURE_WINDOW_SECONDS) return false;

  const presented = String(input.signatureHeader ?? "").trim();
  if (!presented.startsWith("v0=")) return false;

  const base = `v0:${ts}:${typeof input.rawBody === "string" ? input.rawBody : input.rawBody.toString("utf8")}`;
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}
