// CloudSign が返したエラーを捨てずに分類する（v1-reference 計画 §13）。
//
// これまで adapter は `CloudSign API HTTP error: 400` だけを投げており、CloudSign 本体が
// 何を拒否したのかが失われていた。「許可されていないアドレス」が宛先の問題なのか、
// client_id の問題なのか、送信元 IP 制限なのかを切り分けられないのはこのため。
//
// サーバ側では status / method / path / upstream の code と message を保持し、
// UI へはユーザーが対処できる粒度へ正規化して返す。
// access token / client_id / Authorization ヘッダは絶対に持ち回らない。

export type CloudSignFailureKind =
  | "CLOUDSIGN_AUTHENTICATION_FAILED"
  | "CLOUDSIGN_PARTICIPANT_REJECTED"
  | "CLOUDSIGN_IP_RESTRICTED"
  | "CLOUDSIGN_INVALID_REQUEST"
  | "CLOUDSIGN_RATE_LIMITED"
  | "CLOUDSIGN_UPSTREAM_ERROR";

export interface CloudSignUpstreamDetail {
  status: number | null;
  method: string;
  path: string;
  upstreamCode: string | null;
  upstreamMessage: string | null;
  kind: CloudSignFailureKind;
  retryable: boolean;
}

// 秘密が混ざり得る値をエラー本文から落とす。CloudSign が要求内容を echo back した場合の保険。
const SECRET_PATTERNS: RegExp[] = [
  /client_id=[^&\s"']+/gi,
  /access_token["'\s:=]+[A-Za-z0-9._-]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
}

// CloudSign のレスポンス本文から code / message を拾う。JSON でないこともあるので
// その場合は本文の先頭だけを message として扱う（長文・HTML エラーページ対策）。
export function parseUpstreamBody(body: string): { code: string | null; message: string | null } {
  const text = body.trim();
  if (!text) return { code: null, message: null };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const code = firstString(parsed, ["code", "error", "error_code", "errorCode"]);
    const message = firstString(parsed, ["message", "error_description", "detail", "description"]);
    if (code || message) return { code, message: message ? redactSecrets(message) : null };
  } catch { /* JSON でなければ本文をそのまま使う */ }
  return { code: null, message: redactSecrets(text).slice(0, 500) };
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return redactSecrets(value.trim());
    if (typeof value === "number") return String(value);
  }
  return null;
}

// 「許可されていないアドレスです」は宛先と送信元 IP のどちらでも出る文言で、
// これを IP 制限と決めつけるとネットワーク構成の変更へ先走ることになる（計画 §11 原則2）。
// そこで IP と断定するのは IP を明示する語があるときだけにし、
// 「アドレス」しか手掛かりが無い場合は宛先の問題として扱う（診断順序 5a → 5c）。
const IP_HINTS = /ip|ｉｐ|接続元|送信元|allowlist|whitelist/i;
// IP の語があっても、宛先そのものを指す語が併記されていれば宛先側と読む。
const RECIPIENT_EXPLICIT = /participant|recipient|宛先|受信者|署名者|メールアドレス|email/i;
// 「アドレス」単独はここでだけ宛先扱いにする（IP 判定より後ろで評価する）。
const RECIPIENT_LOOSE = /participant|recipient|宛先|受信者|署名者|メールアドレス|email|アドレス/i;

export function classifyCloudSignFailure(input: {
  status: number | null;
  upstreamCode: string | null;
  upstreamMessage: string | null;
}): { kind: CloudSignFailureKind; retryable: boolean } {
  const haystack = `${input.upstreamCode ?? ""} ${input.upstreamMessage ?? ""}`;
  const status = input.status;

  if (status === 429) return { kind: "CLOUDSIGN_RATE_LIMITED", retryable: true };
  if (status !== null && status >= 500) return { kind: "CLOUDSIGN_UPSTREAM_ERROR", retryable: true };

  // 403 は IP 制限と権限不足の両方で返る。文言に IP の手掛かりがあるときだけ IP と断定する。
  if (IP_HINTS.test(haystack) && !RECIPIENT_EXPLICIT.test(haystack)) {
    return { kind: "CLOUDSIGN_IP_RESTRICTED", retryable: false };
  }
  // 401 は宛先文言があっても認証の問題（トークン再取得後もここへ来ている）。
  if (status === 401) return { kind: "CLOUDSIGN_AUTHENTICATION_FAILED", retryable: false };
  if (RECIPIENT_LOOSE.test(haystack)) {
    return { kind: "CLOUDSIGN_PARTICIPANT_REJECTED", retryable: false };
  }
  if (status === 403) return { kind: "CLOUDSIGN_AUTHENTICATION_FAILED", retryable: false };
  if (status !== null && status >= 400) return { kind: "CLOUDSIGN_INVALID_REQUEST", retryable: false };
  return { kind: "CLOUDSIGN_UPSTREAM_ERROR", retryable: true };
}

export function buildUpstreamDetail(input: {
  status: number | null; method: string; path: string; body: string;
}): CloudSignUpstreamDetail {
  const { code, message } = parseUpstreamBody(input.body);
  const { kind, retryable } = classifyCloudSignFailure({
    status: input.status, upstreamCode: code, upstreamMessage: message
  });
  return {
    status: input.status, method: input.method, path: input.path,
    upstreamCode: code, upstreamMessage: message, kind, retryable
  };
}

// 利用者向けの説明。原因ごとに「次に何をすればよいか」まで書く。
const GUIDANCE: Record<CloudSignFailureKind, string> = {
  CLOUDSIGN_AUTHENTICATION_FAILED:
    "CloudSign の認証に失敗しました。設定のAPIキータブでクライアントIDを確認してください。",
  CLOUDSIGN_PARTICIPANT_REJECTED:
    "CloudSign が宛先を受け付けませんでした。署名者・CCのメールアドレスを確認してください。",
  CLOUDSIGN_IP_RESTRICTED:
    "CloudSign 側で送信元IPが制限されています。CloudSign の管理画面でIP許可設定を確認してください。",
  CLOUDSIGN_INVALID_REQUEST:
    "CloudSign が依頼内容を受け付けませんでした。文書・署名者の内容を確認してください。",
  CLOUDSIGN_RATE_LIMITED:
    "CloudSign の呼び出し制限に達しました。しばらく待ってから再実行してください。",
  CLOUDSIGN_UPSTREAM_ERROR:
    "CloudSign 側でエラーが発生しました。時間をおいて再実行してください。"
};

// UI へ返す形。upstream の生本文は返さず、分類・要点・再試行可否だけを渡す。
export function toClientError(detail: CloudSignUpstreamDetail): {
  code: CloudSignFailureKind; error: string; retryable: boolean; upstreamMessage?: string;
} {
  return {
    code: detail.kind,
    error: GUIDANCE[detail.kind],
    retryable: detail.retryable,
    // CloudSign の一文だけは添える（宛先名など、担当者が直せる情報が入るため）。
    ...(detail.upstreamMessage ? { upstreamMessage: detail.upstreamMessage.slice(0, 200) } : {})
  };
}

// サーバログ用の1行。秘密は含めない。
export function toLogLine(detail: CloudSignUpstreamDetail): string {
  return [
    `[cloudsign] ${detail.method} ${detail.path}`,
    `status=${detail.status ?? "-"}`,
    `kind=${detail.kind}`,
    `retryable=${detail.retryable}`,
    detail.upstreamCode ? `code=${detail.upstreamCode}` : "",
    detail.upstreamMessage ? `message=${detail.upstreamMessage.slice(0, 300)}` : ""
  ].filter(Boolean).join(" ");
}
