// API 応答の読み取り。
//
// 失敗応答は必ず JSON とは限らない。Cloud Run / IAP が返す 502・503 は本文が
// "Service Unavailable" のような素のテキストで、これを response.json() に通すと
// SyntaxError になり、その文面（Unexpected token 'S', "Service Unavailable" is
// not valid JSON）がそのまま画面に出ていた。利用者には何が起きたか分からず、
// 再実行すべきかどうかも判断できない。本文はテキストで読んでから解釈する。

/** 失敗の説明文を作る（純関数）。body は応答本文そのまま。 */
export function describeHttpFailure(
  status: number,
  body: string,
  fallback: string
): string {
  // アプリが返す JSON エラー（{ error: "…" }）はそのまま使う。
  const fromJson = errorFromJson(body);
  if (fromJson) return fromJson;
  const hint = hintForStatus(status);
  return hint ? `${fallback}${hint}（HTTP ${status}）` : `${fallback}（HTTP ${status}）`;
}

function errorFromJson(body: string): string {
  const text = body.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return "";
  try {
    const parsed = JSON.parse(text);
    const message = (parsed as { error?: unknown })?.error;
    return typeof message === "string" && message.trim() ? message.trim() : "";
  } catch {
    return "";
  }
}

function hintForStatus(status: number): string {
  // 502/503/504 はサーバ側の一時的な不調。再実行で通ることが多い。
  if (status === 502 || status === 503 || status === 504) {
    return "サーバが一時的に応答しませんでした。少し待ってから再実行してください。";
  }
  if (status === 401 || status === 403) {
    return "権限がないか、ログインの有効期限が切れています。画面を再読み込みしてください。";
  }
  if (status === 413) return "送信内容が大きすぎます。";
  if (status === 504) return "処理が時間内に終わりませんでした。";
  return "";
}

export type JsonResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; data: unknown };

/**
 * 応答を JSON として読む。JSON でない失敗応答でも例外にせず、
 * 何が起きたか分かる message を返す。
 */
export async function readJsonResponse<T = unknown>(
  response: Response,
  fallback: string
): Promise<JsonResponse<T>> {
  const body = await response.text().catch(() => "");
  let data: unknown = undefined;
  try {
    data = body.trim() ? JSON.parse(body) : undefined;
  } catch {
    // JSON でない本文（素のテキスト・HTML のエラーページ）。message 側で扱う。
  }
  if (response.ok) return { ok: true, data: data as T };
  return {
    ok: false,
    status: response.status,
    message: describeHttpFailure(response.status, body, fallback),
    data
  };
}
