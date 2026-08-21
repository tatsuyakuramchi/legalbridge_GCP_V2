import { Router } from "express";
import { z } from "zod";
import type { AppSettingsRepository } from "./settings-repository.js";
import {
  DEFAULT_EMAIL_TEMPLATES, EMAIL_TOKENS, loadEmailSettings,
  applyEmailTokens, cleanupRenderedBody, type EmailKind
} from "./email-settings.js";
import type { GmailDeliveryAdapter } from "../integrations/gmail-delivery-adapter.js";
import { isValidEmail } from "../integrations/gmail-delivery-adapter.js";
import {
  evaluateGmailDispatchGate, type GmailDispatchGateSettings
} from "../integrations/gmail-dispatch-gate.js";
import { DEFAULT_COMPANY_PROFILE, type CompanyProfile } from "./company-profile.js";

// メール設定（文面テンプレート・既定CC・テスト送信）。V1 loadEmailCfg の設定群の移植。
// 保存は既存の app_settings（grant 036・SETTINGS_WRITE_ENABLED ゲート）を使い、
// キーは V1 互換（email_subject_* / email_body_* / email_cc）。admin のみ。

const KINDS: EmailKind[] = ["inspection", "royalty", "general"];

const templateSchema = z.object({
  subject: z.string().max(200, "件名は200文字までです"),
  body: z.string().max(4000, "本文は4000文字までです")
});
const saveSchema = z.object({
  cc: z.string().max(500).optional().default(""),
  templates: z.object({
    inspection: templateSchema, royalty: templateSchema, general: templateSchema
  })
});
const testSchema = z.object({
  to: z.string().trim().min(1, "宛先が必要です").max(255),
  kind: z.enum(["inspection", "royalty", "general"]),
  // 未保存の編集中テンプレートでも試せるよう、任意で上書きを受ける。
  subject: z.string().max(200).optional(),
  body: z.string().max(4000).optional()
});

function adminOnly(role: string | undefined) { return role === "admin"; }

// テスト送信のプレビュー変数（架空データ・EMAIL_TOKENS の sample と一致させる）。
function sampleVars(company: CompanyProfile): Record<string, string> {
  const bySample = Object.fromEntries(EMAIL_TOKENS.map((t) => [t.token.replace(/[{}]/g, ""), t.sample]));
  return {
    ...bySample,
    date: new Date().toLocaleDateString("ja-JP"),
    companyName: company.name,
    companyAddress: company.address,
    companyTel: company.tel
  };
}

export function createEmailSettingsRouter(dependencies: {
  repository?: AppSettingsRepository;
  writeEnabled?: boolean;
  gmail?: GmailDeliveryAdapter;
  gateSettings: GmailDispatchGateSettings;
  companyProfile?: () => Promise<CompanyProfile>;
}) {
  const { repository, gmail, gateSettings } = dependencies;
  const writeEnabled = dependencies.writeEnabled === true;
  const router = Router();

  async function company(): Promise<CompanyProfile> {
    try {
      return dependencies.companyProfile ? await dependencies.companyProfile() : DEFAULT_COMPANY_PROFILE;
    } catch { return DEFAULT_COMPANY_PROFILE; }
  }

  // 現在値＋既定文面＋トークン一覧。プレビューは client がトークン置換して描く。
  router.get("/email-settings", async (_request, response, next) => {
    try {
      if (!adminOnly(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "管理者のみが編集できます", code: "EMAIL_SETTINGS_FORBIDDEN" });
      }
      const settings = await loadEmailSettings(repository);
      return response.status(200).json({
        cc: settings.cc,
        custom: settings.custom,               // 保存済みの生値（空欄＝既定を使用中）
        defaults: DEFAULT_EMAIL_TEMPLATES,
        tokens: EMAIL_TOKENS,
        sampleVars: sampleVars(await company()),
        writeEnabled
      });
    } catch (error) { return next(error); }
  });

  // 保存。既定と同じ内容は空欄として保存（＝既定に追従し続ける）。
  router.post("/email-settings", async (request, response, next) => {
    try {
      if (!adminOnly(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "管理者のみが編集できます", code: "EMAIL_SETTINGS_FORBIDDEN" });
      }
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "設定の保存は現在有効化されていません", code: "EMAIL_SETTINGS_WRITE_UNAVAILABLE" });
      }
      const input = saveSchema.parse(request.body ?? {});
      const values: Record<string, string> = { email_cc: input.cc.trim() };
      for (const kind of KINDS) {
        const tpl = input.templates[kind];
        const def = DEFAULT_EMAIL_TEMPLATES[kind];
        values[`email_subject_${kind}`] = tpl.subject.trim() === def.subject ? "" : tpl.subject.trim();
        values[`email_body_${kind}`] = tpl.body.trim() === def.body.trim() ? "" : tpl.body;
      }
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      try {
        await repository.save(values, actor);
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({ error: "設定書込の権限が付与されていません", code: "SETTINGS_FORBIDDEN_DB" });
        }
        throw error;
      }
      const settings = await loadEmailSettings(repository);
      return response.status(200).json({ saved: true, cc: settings.cc, custom: settings.custom });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // テスト送信（admin のみ・架空データで描画）。履歴・案件送信履歴には記録しない。
  // 件名に【テスト送信】を付け、冪等キーは毎回ユニーク（重複ブロックを通さない）。
  router.post("/email-settings/test", async (request, response, next) => {
    try {
      if (!adminOnly(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "管理者のみが実行できます", code: "EMAIL_SETTINGS_FORBIDDEN" });
      }
      const input = testSchema.parse(request.body ?? {});
      if (!isValidEmail(input.to)) {
        return response.status(400).json({ error: "宛先メールアドレスが不正です", code: "EMAIL_TEST_RECIPIENT_INVALID" });
      }
      const settings = await loadEmailSettings(repository);
      const template = {
        subject: (input.subject ?? "").trim() || settings.templates[input.kind].subject,
        body: (input.body ?? "").trim() ? String(input.body) : settings.templates[input.kind].body
      };
      const vars = sampleVars(await company());
      const subject = `【テスト送信】${applyEmailTokens(template.subject, vars)}`;
      const bodyText =
        cleanupRenderedBody(applyEmailTokens(template.body, vars)) +
        "\n\n※ これはメール設定画面からのテスト送信です（本文の値はすべて架空データ）。";
      const gate = evaluateGmailDispatchGate({ to: input.to, subject, bodyText }, gateSettings);
      if (!gate.dispatchAllowed) {
        return response.status(409).json({
          error: "送信条件が整っていません", code: "EMAIL_TEST_BLOCKED", blockers: gate.blockerLabels
        });
      }
      if (!gmail) {
        return response.status(503).json({ error: "gmail delivery unavailable", code: "EMAIL_TEST_UNAVAILABLE" });
      }
      const receipt = await gmail.send({
        to: input.to, subject, bodyText,
        fromEmail: gateSettings.senderEmail, fromName: "LegalBridge",
        idempotencyKey: `email-settings-test:${Date.now()}:${Math.floor(Math.random() * 1e9)}`
      });
      return response.status(201).json({ receipt, preview: { subject, bodyText } });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
