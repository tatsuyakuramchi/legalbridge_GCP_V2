import { timingSafeEqual } from "node:crypto";

// 内部エンドポイント（Cloud Scheduler 起動口 / 外部 Webhook 受信口）の共有シークレット照合。
// ユーザー認証（IAP/Cloud Run IAM）をバイパスする代わりに、各エンドポイントが自前で
// 事前設定シークレットとリクエストのトークンを**定数時間比較**する。既定は未設定＝無効。

export function tokensMatch(configured: string | undefined | null, presented: string | undefined | null): boolean {
  const a = String(configured ?? "");
  const b = String(presented ?? "");
  // 未設定（空）は常に不一致＝無効化。
  if (a.length === 0) return false;
  // 長さが異なると timingSafeEqual が例外を投げるため、長さ不一致は先に false。
  // 長さ自体は秘密ではないので早期リターンで問題ない。
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Bearer / 独自ヘッダのどちらでも受ける。空・欠落は null。
export function extractPresentedToken(headerToken: string | undefined, authorization: string | undefined): string | null {
  const direct = (headerToken ?? "").trim();
  if (direct) return direct;
  const auth = (authorization ?? "").trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim() || null;
  return null;
}
