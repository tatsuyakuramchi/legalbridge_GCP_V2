import { Router, type Request } from "express";
import { config } from "../config.js";
import type { GoogleLogin } from "./google-login.js";

/**
 * 「Google にログイン」の 2 つの口（google-login.ts）。
 *
 *   GET /auth/google/login     state を作って Google の許可画面へ送る（運用 › 外部連携 のボタン）
 *   GET /auth/google/callback  Google から戻る。コードを保存して画面へ戻す
 *
 * どちらもユーザー認証の内側（app.ts で authenticate のあと）。戻り先は GOOGLE_LOGIN_REDIRECT_URL、
 * 無ければ画面の URL（Host）から組む。GCP の OAuth クライアントに同じ URL を登録しておく。
 */
export function createGoogleLoginRouter(login: GoogleLogin): Router {
  const router = Router();
  const allowed = (req: Request) => {
    const role = (req.res?.locals.currentUser as { role?: string } | undefined)?.role;
    return role === "admin" || role === "legal";
  };
  const back = (q: Record<string, string>) => `/#/ops/integrations?${new URLSearchParams(q).toString()}`;

  router.get("/login", (req, res) => {
    if (!allowed(req)) return res.status(403).json({ error: "利用が許可されていません" });
    if (!login.configured) return res.redirect(back({ google: "error", msg: "Google のログインは設定されていません（GOOGLE_LOGIN_CLIENT_ID / SECRET）" }));
    const { url } = login.start(redirectUrl(req));
    return res.redirect(url);
  });

  router.get("/callback", async (req, res) => {
    if (!allowed(req)) return res.status(403).json({ error: "利用が許可されていません" });
    const error = String(req.query.error ?? "");
    if (error) return res.redirect(back({ google: "error", msg: `Google が許可しませんでした：${error}` }));
    const code = String(req.query.code ?? ""), state = String(req.query.state ?? "");
    if (!code || !state) return res.redirect(back({ google: "error", msg: "Google からコードが戻りませんでした" }));
    try {
      const r = await login.finish({ code, state, redirectUrl: redirectUrl(req) });
      return res.redirect(back({ google: "ok", ...(r.email ? { email: r.email } : {}) }));
    } catch (e) {
      return res.redirect(back({ google: "error", msg: e instanceof Error ? e.message : String(e) }));
    }
  });
  return router;
}

export function redirectUrl(req: Request): string {
  if (config.googleLoginRedirectUrl) return config.googleLoginRedirectUrl;
  const proto = String(req.header("x-forwarded-proto") ?? req.protocol ?? "http").split(",")[0]!.trim();
  const host = String(req.header("x-forwarded-host") ?? req.header("host") ?? "localhost").split(",")[0]!.trim();
  return `${proto}://${host}/auth/google/callback`;
}
