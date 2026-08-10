import { Router, urlencoded, type Request } from "express";
import { verifySlackSignature } from "../integrations/slack-signature.js";

// Slack スラッシュコマンド／インタラクティビティ受信口（Phase 16-3a）。
// ユーザー認証（IAP/IAM）をバイパスする代わりに **Slack 署名（signing secret・HMAC）** で検証する。
// 共有トークン方式（/internal/webhooks）と異なり Slack は任意ヘッダを付けられないため署名方式。
// signing secret 未設定 or handler 未注入 = 404（既定 OFF）。署名検証は fail-closed。

export type SlackCommandHandler = (body: Record<string, string | undefined>) => Promise<{ status: number; body: unknown }>;
export type SlackInteractivityHandler = (payload: unknown) => Promise<{ status: number; body: unknown }>;

export interface SlackIntakeRouterOptions {
  signingSecret?: string;
  onCommand?: SlackCommandHandler;
  onInteractivity?: SlackInteractivityHandler;
  nowSeconds?: () => number;   // テスト用
}

interface RawBodyRequest extends Request { rawBody?: Buffer; }

export function createSlackIntakeRouter(options: SlackIntakeRouterOptions = {}) {
  const router = Router();
  const enabled = Boolean(options.signingSecret) && Boolean(options.onCommand) && Boolean(options.onInteractivity);

  // Slack は application/x-www-form-urlencoded で送る。署名は生ボディに対して計算されるため
  // verify フックで rawBody を保持する（express.json はこの content-type を素通しする）。
  const parser = urlencoded({
    extended: false,
    verify: (request, _response, buffer) => { (request as RawBodyRequest).rawBody = buffer; }
  });

  function verify(request: RawBodyRequest): boolean {
    return verifySlackSignature({
      signingSecret: options.signingSecret,
      timestampHeader: request.header("x-slack-request-timestamp"),
      signatureHeader: request.header("x-slack-signature"),
      rawBody: request.rawBody ?? Buffer.alloc(0),
      nowSeconds: options.nowSeconds?.()
    });
  }

  router.post("/internal/slack/commands", parser, async (request: RawBodyRequest, response) => {
    if (!enabled) return response.status(404).json({ error: "not found", code: "SLACK_INTAKE_DISABLED" });
    if (!verify(request)) return response.status(401).json({ error: "invalid slack signature", code: "SLACK_INTAKE_UNAUTHORIZED" });
    try {
      const out = await options.onCommand!(request.body as Record<string, string | undefined>);
      return response.status(out.status).send(out.body as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response.status(500).json({ ok: false, error: message, code: "SLACK_INTAKE_FAILED" });
    }
  });

  router.post("/internal/slack/interactivity", parser, async (request: RawBodyRequest, response) => {
    if (!enabled) return response.status(404).json({ error: "not found", code: "SLACK_INTAKE_DISABLED" });
    if (!verify(request)) return response.status(401).json({ error: "invalid slack signature", code: "SLACK_INTAKE_UNAUTHORIZED" });
    try {
      // interactivity は payload=<JSON> の form-encoded。壊れた JSON は 400。
      let payload: unknown;
      try {
        payload = JSON.parse(String((request.body as Record<string, unknown>)?.payload ?? ""));
      } catch {
        return response.status(400).json({ error: "invalid payload", code: "SLACK_INTAKE_BAD_PAYLOAD" });
      }
      const out = await options.onInteractivity!(payload);
      return response.status(out.status).send(out.body as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response.status(500).json({ ok: false, error: message, code: "SLACK_INTAKE_FAILED" });
    }
  });

  return router;
}
