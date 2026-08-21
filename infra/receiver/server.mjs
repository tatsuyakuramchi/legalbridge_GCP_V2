// lb-v2-receiver — 外部 Webhook / Slack 受信専用の公開リレー（runbook 2-4）。
//
// 本体（legalbridge-v2-write-test）は Cloud Run 統合 IAP の背後にあり、CloudSign / Backlog /
// Slack は Google OIDC を提示できないため直接届かない。本サービスは allUsers 公開で受け、
// **許可された 4 パスのみ**を、メタデータサーバで取得した OIDC ID トークン
// （audience = IAP の programmaticClients に登録済みクライアント ID）を付けて本体へ転送する。
//
// セキュリティ境界：
//   - 転送先はアプリ層の検証（X-Webhook-Token 共有シークレット／Slack v0 署名）が必ず効く。
//     リレー自体は認証を持たない＝「公開して良いのは、その先で検証されるものだけ」。
//   - 許可パス以外は 404。メソッドは POST のみ（/healthz を除く）。ボディ上限 1MB。
//   - 転送するヘッダは allowlist（content-type / x-webhook-token / x-slack-*）のみ。
//     受信した Authorization は破棄し、自前の ID トークンに差し替える。
//
// env: UPSTREAM（本体 URL・必須）／AUDIENCE（IAP クライアント ID・必須）／PORT（既定 8080）

import http from "node:http";

const UPSTREAM = (process.env.UPSTREAM ?? "").replace(/\/+$/, "");
const AUDIENCE = process.env.AUDIENCE ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
// 資料アップロード中継（V1停止・案A）はファイルを運ぶため、このパスだけ上限と
// タイムアウトを引き上げる（本体側の上限 30MB + multipart 封筒分）。
const UPLOAD_PATH = "/api/attachments/by-issue";
const UPLOAD_MAX_BODY_BYTES = 35 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

if (!UPSTREAM || !AUDIENCE) {
  console.error("UPSTREAM and AUDIENCE env vars are required");
  process.exit(1);
}

export const ALLOWED_PATHS = new Set([
  "/internal/webhooks/cloudsign",
  "/internal/webhooks/backlog",
  "/internal/slack/commands",
  "/internal/slack/interactivity",
  // 検索ポータルの資料アップロード中継（search-api → 本体・x-lb-portal-secret で本体が検証）
  UPLOAD_PATH
]);

const FORWARD_HEADERS = [
  "content-type",
  "x-webhook-token",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-lb-portal-secret",
  "x-lb-uploader-email"
];

// メタデータサーバの ID トークン（audience 指定）。有効期限 1h なので 50 分キャッシュ。
let cachedToken = { value: "", expiresAt: 0 };
async function identityToken() {
  const now = Date.now();
  if (cachedToken.value && now < cachedToken.expiresAt) return cachedToken.value;
  const url =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity" +
    `?audience=${encodeURIComponent(AUDIENCE)}&format=full`;
  const response = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`metadata identity token failed: ${response.status}`);
  const value = (await response.text()).trim();
  cachedToken = { value, expiresAt: now + 50 * 60 * 1000 };
  return value;
}

function readBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  const path = (request.url ?? "").split("?")[0];

  if (request.method === "GET" && path === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "lb-v2-receiver" }));
    return;
  }
  if (request.method !== "POST" || !ALLOWED_PATHS.has(path)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const isUpload = path === UPLOAD_PATH;
    const body = await readBody(request, isUpload ? UPLOAD_MAX_BODY_BYTES : MAX_BODY_BYTES);
    const headers = { authorization: `Bearer ${await identityToken()}` };
    for (const name of FORWARD_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string" && value) headers[name] = value;
    }
    // Backlog / CloudSign は Webhook 登録で URL しか設定できない（カスタムヘッダ不可）ため、
    // `?token=…` を本体が検証する X-Webhook-Token ヘッダへ変換する（ヘッダ指定があれば優先）。
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const queryToken = query.get("token");
    if (queryToken && !headers["x-webhook-token"] && path.startsWith("/internal/webhooks/")) {
      headers["x-webhook-token"] = queryToken;
    }
    const upstream = await fetch(`${UPSTREAM}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(isUpload ? UPLOAD_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS)
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json"
    });
    response.end(responseBody);
  } catch (error) {
    const status = error?.statusCode === 413 ? 413 : 502;
    console.error(`[receiver] ${path} relay failed:`, error?.message ?? error);
    if (!response.headersSent) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: status === 413 ? "payload too large" : "relay failed" }));
    } else {
      response.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`lb-v2-receiver listening on :${PORT} -> ${UPSTREAM} (audience=${AUDIENCE.slice(0, 12)}…)`);
});
