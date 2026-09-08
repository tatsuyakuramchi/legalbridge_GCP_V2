export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v3${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? "エラーが発生しました", body.code);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" })
};

/** 最小通貨単位の整数を表示用に戻す。 */
export function money(amount: number | null, currency = "JPY"): string {
  if (amount === null || amount === undefined) return "—";
  const minor = ["JPY", "KRW", "VND"].includes(currency) ? 1 : 100;
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency })
    .format(amount / minor);
}

/** 百万分率を % 表示へ。 */
export const rate = (ppm: number | null): string =>
  ppm === null || ppm === undefined ? "—" : `${(ppm / 10000).toFixed(3)}%`;
