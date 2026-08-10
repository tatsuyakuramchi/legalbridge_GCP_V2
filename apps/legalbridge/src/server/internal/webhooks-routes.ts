import { Router } from "express";
import { tokensMatch, extractPresentedToken } from "./shared-secret.js";

// 外部 Webhook 受信口（CloudSign / Backlog → Cloud Run）。ユーザー認証をバイパスし、
// ソースごとの共有シークレットで保護する。既定 OFF（handler 未注入 or token 未設定）。
// 受信ペイロードの解釈・副作用は handler に委譲する（本 slice では枠のみ・9-5/9-7 で実装を差し込む）。

export type WebhookHandler = (payload: unknown, headers: Record<string, string | undefined>) => Promise<{ status?: number; body?: unknown }>;

export interface WebhookSource {
  token?: string;
  handler?: WebhookHandler;
}

export interface WebhooksRouterOptions {
  cloudsign?: WebhookSource;
  backlog?: WebhookSource;
}

function mount(router: Router, path: string, source: WebhookSource | undefined) {
  const enabled = Boolean(source?.token) && Boolean(source?.handler);
  router.post(path, async (request, response) => {
    if (!enabled || !source) return response.status(404).json({ error: "not found", code: "WEBHOOK_DISABLED" });
    const presented = extractPresentedToken(request.header("x-webhook-token"), request.header("authorization"));
    if (!tokensMatch(source.token, presented)) {
      return response.status(401).json({ error: "invalid webhook token", code: "WEBHOOK_UNAUTHORIZED" });
    }
    try {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(request.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;
      const out = await source.handler!(request.body, headers);
      return response.status(out.status ?? 200).json(out.body ?? { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response.status(500).json({ ok: false, error: message, code: "WEBHOOK_FAILED" });
    }
  });
}

export function createWebhooksRouter(options: WebhooksRouterOptions = {}) {
  const router = Router();
  mount(router, "/internal/webhooks/cloudsign", options.cloudsign);
  mount(router, "/internal/webhooks/backlog", options.backlog);
  return router;
}
