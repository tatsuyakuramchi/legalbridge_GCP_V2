import { Router } from "express";
import { z } from "zod";
import Handlebars from "handlebars";
import type { TemplateRepository } from "./template-repository.js";
import { registerLegacyHelpers } from "./rendering.js";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";
import { SAMPLE_HIDDEN_KEYS, buildSampleFormData, sampleVariantsFor } from "./sample-preview.js";

// ひな形プレビュー（V1 search-api /templates/preview の V2 版・読み取り専用）。
// 事業部担当者がフォーム入力なしで各テンプレートの文面をサンプル値入りで確認する。
// 認証済みであれば全ロール閲覧可（実データを含まない・書込なし・GET のみ）。
export function createTemplateSampleRouter(templates: TemplateRepository) {
  const router = Router();

  const requireUser = (response: { locals: { currentUser?: unknown } }) =>
    Boolean(response.locals.currentUser);

  router.get("/template-samples", async (_request, response, next) => {
    try {
      if (!requireUser(response)) {
        return response.status(401).json({ error: "authentication is required" });
      }
      const list = await templates.list();
      const items = list
        .filter((template) => !SAMPLE_HIDDEN_KEYS.has(template.templateKey))
        .map((template) => ({
          templateKey: template.templateKey,
          label: template.label,
          category: template.category ?? "",
          variants: sampleVariantsFor(template.templateKey)
            .map(({ id, label }) => ({ id, label }))
        }));
      return response.status(200).json({ templates: items });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/template-samples/:templateKey/html", async (request, response, next) => {
    try {
      if (!requireUser(response)) {
        return response.status(401).json({ error: "authentication is required" });
      }
      const params = z.object({ templateKey: z.string().trim().min(1).max(100) }).parse(request.params);
      const query = z.object({ variant: z.string().trim().max(50).optional() }).parse(request.query);
      if (SAMPLE_HIDDEN_KEYS.has(params.templateKey)) {
        return response.status(404).json({ error: "template not found" });
      }
      const variants = sampleVariantsFor(params.templateKey);
      const variant = variants.find((v) => v.id === (query.variant ?? variants[0].id));
      if (!variant) {
        return response.status(400).json({
          error: "unknown variant", variants: variants.map((v) => v.id)
        });
      }
      const [schema, source, partials] = await Promise.all([
        templates.findCurrent(params.templateKey),
        templates.findRenderSource(params.templateKey),
        templates.findPartials()
      ]);
      if (!schema || !source) {
        return response.status(404).json({ error: "template not found" });
      }
      const handlebars = Handlebars.create();
      registerLegacyHelpers(handlebars);
      for (const [name, partial] of Object.entries(partials)) {
        handlebars.registerPartial(name, partial);
      }
      const render = handlebars.compile(source.htmlSource, { strict: false, noEscape: false });
      const formData = buildSampleFormData(
        schema.fields, source.htmlSource, schema.label, variant.overrides
      );
      const html = render(buildTemplateDocumentContext(params.templateKey, formData));
      return response.status(200).type("html").send(html);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      return next(error);
    }
  });

  return router;
}
