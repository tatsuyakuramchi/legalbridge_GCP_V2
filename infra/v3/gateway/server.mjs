// =====================================================================
// V3 の外向きの口（legalbridge-v3-gateway）
//
//   V3 本体（legalbridge-v3）は --no-allow-unauthenticated のまま、社内の人は
//   `gcloud run services proxy` で開く。一方で Slack と依頼者（V3 に入れない人）は
//   外から届く必要がある。そこで、決まったパスだけを V3 へ中継する小さな公開サービスを
//   別に置く。V3 本体の画面・API は、この口からは一切開けない。
//
//   通すもの（これ以外は 404）
//     POST /internal/slack/commands      … /法務依頼・/法務検索（Slack の署名で守る）
//     POST /internal/slack/interactions  … モーダルの送信（同上）
//     GET  /internal/upload              … 依頼者の資料アップロードのページ（署名付きリンクで守る）
//     POST /internal/upload/file         … そのファイル（同上。1 ファイル 30MB まで）
//
//   V3 へは、この口のサービスアカウントの ID トークンを付けて呼ぶ
//   （V3 側でこのアカウントに roles/run.invoker を付ける）。
//   依存パッケージは使わない（Node 20 の標準だけ）。
//
//   環境変数
//     UPSTREAM          V3 本体の URL（https://legalbridge-v3-xxxx.a.run.app）。必須
//     PORT              既定 8080（Cloud Run が入れる）
//     AUDIENCES         ID トークンの宛先の候補（カンマ区切り）。IAP が付いた V3 は
//                       https://<サービス>-<プロジェクト番号>.<リージョン>.run.app を受け付ける
//     GATEWAY_AUTH      oidc（既定：ID トークン）／ iap-jwt（V3 に IAP が付いているとき。自分で署名した JWT）
//     GATEWAY_NO_AUTH=1 手元の試験用。ID トークンを付けない
// =====================================================================

import http from "node:http";

const UPSTREAM = (process.env.UPSTREAM ?? "").replace(/\/+$/, "");
// ID トークンの宛先（audience）の候補。V3 本体に IAP が付いていると、IAP が受け付ける宛先は
// サービスの URL のうち決まった一方だけのことがある（2026-09-27 に "Invalid JWT audience" で断られた）。
// 候補を順に試し、通ったものを覚える。既定は UPSTREAM だけ。
const AUDIENCES = [...new Set([
  ...(process.env.AUDIENCES ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
  UPSTREAM
])];
const PORT = Number(process.env.PORT ?? 8080);
const NO_AUTH = process.env.GATEWAY_NO_AUTH === "1";
const MAX_BODY = 31 * 1024 * 1024;

if (!UPSTREAM) {
  console.error("UPSTREAM（V3 本体の URL）が未設定です");
  process.exit(1);
}

/** 通すパス。完全一致だけ（前方一致にすると ../ などで他へ抜けられる）。 */
export const ROUTES = [
  ["POST", "/internal/slack/commands"],
  ["POST", "/internal/slack/interactions"],
  ["GET", "/internal/upload"],
  ["POST", "/internal/upload/file"]
];
export const allowed = (method, pathname) =>
  ROUTES.some(([m, p]) => m === method && p === pathname);

/** V3 へ渡すヘッダ。署名の検証に要るものと本文の形だけ。 */
const PASS_REQUEST = ["content-type", "x-slack-signature", "x-slack-request-timestamp", "user-agent", "accept", "accept-language"];
const PASS_RESPONSE = ["content-type", "cache-control", "referrer-policy", "content-security-policy"];

// ID トークンは 1 時間もつ。50 分で取り直す。宛先ごとに持つ。
const cache = new Map();
async function idToken(audience) {
  if (NO_AUTH) return "";
  const hit = cache.get(audience);
  if (hit && Date.now() < hit.until) return hit.token;
  const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
    + `?audience=${encodeURIComponent(audience)}&format=full`;
  const r = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`ID トークンを取れませんでした (${r.status})`);
  const token = (await r.text()).trim();
  cache.set(audience, { token, until: Date.now() + 50 * 60 * 1000 });
  return token;
}
/** いま使う宛先（通ったものを先頭に寄せる）。 */
let working = 0;

// V3 本体に IAP が付いていて、IAP が Google 管理の OAuth クライアントを使っているとき、
// サービスアカウントの ID トークン（OIDC）は受け付けられない（"Invalid JWT audience"）。
// 代わりに、口のサービスアカウントが自分で署名した JWT（aud = 守られている URL/*）を送る。
// 署名は IAM Credentials の signJwt（口のアカウントに自分自身の Token Creator が要る）。
const MODE = (process.env.GATEWAY_AUTH ?? "oidc").trim();   // "oidc" | "iap-jwt"
let signed = { token: "", until: 0 };
async function metadata(path) {
  const r = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`メタデータを読めませんでした (${path}: ${r.status})`);
  return r.text();
}
async function iapJwt() {
  if (signed.token && Date.now() < signed.until) return signed.token;
  const email = (await metadata("instance/service-accounts/default/email")).trim();
  const access = JSON.parse(await metadata("instance/service-accounts/default/token")).access_token;
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iss: email, sub: email, aud: `${UPSTREAM}/*`, iat: now, exp: now + 3600 });
  const r = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`, {
    method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ payload })
  });
  if (!r.ok) throw new Error(`JWT に署名できませんでした (${r.status}: ${(await r.text()).slice(0, 200)})`);
  signed = { token: (await r.json()).signedJwt, until: Date.now() + 50 * 60 * 1000 };
  return signed.token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;                       // 上限を超えた後は読み捨てる（切断すると理由が届かない）
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => { if (over) reject(Object.assign(new Error("too large"), { status: 413 })); });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
  if (!allowed(req.method, url.pathname)) return send(res, 404, { error: "not found" });

  try {
    const body = req.method === "GET" ? undefined : await readBody(req);
    const headers = {};
    for (const h of PASS_REQUEST) if (req.headers[h]) headers[h] = String(req.headers[h]);
    const fwd = req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = String(fwd ?? req.socket.remoteAddress ?? "");

    // パスは許したものをそのまま使い、クエリだけ引き継ぐ（署名付きリンクの t= など）。
    // IAP に宛先違いで断られたら、次の候補の宛先で取り直して 1 回ずつ試す。
    let upstream;
    if (MODE === "iap-jwt" && !NO_AUTH) {
      headers.authorization = `Bearer ${await iapJwt()}`;
      upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method, headers, body, redirect: "manual"
      });
    }
    for (let i = 0; !upstream && i < AUDIENCES.length; i += 1) {
      const idx = (working + i) % AUDIENCES.length;
      const token = await idToken(AUDIENCES[idx]);
      if (token) headers.authorization = `Bearer ${token}`;
      upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method, headers, body, redirect: "manual"
      });
      if (upstream.status !== 401 || NO_AUTH) { working = idx; break; }
      const text = await upstream.clone().text().catch(() => "");
      if (!/audience/i.test(text)) { working = idx; break; }
      console.warn("gateway: IAP が宛先を受け付けなかった", AUDIENCES[idx]);
    }
    const out = { "x-content-type-options": "nosniff" };
    for (const h of PASS_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    const status = error?.status === 413 ? 413 : 502;
    console.error("gateway", req.method, url.pathname, status, error?.message);
    send(res, status, { error: status === 413 ? "1 ファイル 30MB までです" : "中継できませんでした。しばらくしてからやり直してください" });
  }
});

if (process.env.GATEWAY_NO_LISTEN !== "1") {
  server.listen(PORT, () => console.log(`legalbridge-v3-gateway :${PORT} → ${UPSTREAM}（${MODE === "iap-jwt" ? `IAP の JWT aud=${UPSTREAM}/*` : `宛先の候補 ${AUDIENCES.join(" / ")}`}）`));
}
