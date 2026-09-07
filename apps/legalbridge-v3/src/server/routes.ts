import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Transactable } from "./core/db.js";
import { DomainError, statusFor } from "./core/errors.js";
import { requireRole, requireWritable } from "./auth.js";
import { ConditionRepository } from "./conditions/repository.js";
import { ConditionWriteService } from "./conditions/write-service.js";
import { MatterRepository } from "./matters/repository.js";
import { WorkRepository } from "./works/repository.js";
import { checkAgainstEnvelope } from "./works/envelope.js";
import { DocumentRepository } from "./documents/repository.js";
import { DocumentIssueService } from "./documents/issue-service.js";
import { ChromiumPdfRenderer, MemoryPdfRenderer, type PdfRenderer } from "./documents/pdf-renderer.js";

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };

export function createRoutes(database: Transactable) {
  const router = Router();
  const conditions = new ConditionRepository(database);
  const conditionWrites = new ConditionWriteService(database);
  const matters = new MatterRepository(database);
  const works = new WorkRepository(database);
  const documents = new DocumentRepository(database);
  const issues = new DocumentIssueService(database);
  const pdf: PdfRenderer = process.env.PDF_RENDERER === "memory"
    ? new MemoryPdfRenderer() : new ChromiumPdfRenderer();
  const actor = (res: Response) => res.locals.currentUser?.email ?? "unknown";

  // ---- 案件（制御レイヤー） ----
  router.get("/matters", asyncRoute(async (req, res) => {
    const kind = req.query.kind as "work" | "outsourcing" | "single" | undefined;
    res.json({ matters: await matters.list({
      keyword: String(req.query.q ?? ""),
      kind: kind && ["work", "outsourcing", "single"].includes(kind) ? kind : undefined,
      openOnly: req.query.open === "1"
    }) });
  }));

  router.get("/matters/:id", asyncRoute(async (req, res) => {
    const matter = await matters.find(Number(req.params.id));
    if (!matter) return res.status(404).json({ error: "案件が見つかりません" });
    res.json(matter);
  }));

  // ---- 条件 ----
  router.get("/conditions", asyncRoute(async (req, res) => {
    const direction = req.query.direction as "in" | "out" | undefined;
    res.json({ conditions: await conditions.list({
      keyword: String(req.query.q ?? ""),
      direction: direction === "in" || direction === "out" ? direction : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      workId: req.query.workId ? Number(req.query.workId) : undefined
    }) });
  }));

  router.get("/conditions/:id", asyncRoute(async (req, res) => {
    const detail = await conditions.find(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: "条件が見つかりません" });
    // OUT条件なら、作品の権利包絡と照合した結果を添える。
    let envelopeCheck = null;
    if (detail.direction === "out" && detail.work) {
      const envelope = await works.envelope(detail.work.id);
      if (envelope) envelopeCheck = { envelope, check: checkAgainstEnvelope(detail, envelope) };
    }
    res.json({ ...detail, envelopeCheck });
  }));

  const counterpartySchema = z.object({ partyId: z.coerce.number().int().positive() });
  router.patch("/conditions/:id/counterparty",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { partyId } = counterpartySchema.parse(req.body ?? {});
      res.json(await conditionWrites.changeCounterparty(Number(req.params.id), partyId, actor(res)));
    }));

  const economicsSchema = z.object({
    name: z.string().trim().min(1).max(300).optional(),
    ratePpm: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
    flatAmount: z.coerce.number().int().nullable().optional(),
    unitAmount: z.coerce.number().int().nullable().optional(),
    mgAmount: z.coerce.number().int().nullable().optional(),
    agAmount: z.coerce.number().int().nullable().optional(),
    termStart: z.string().date().nullable().optional(),
    termEnd: z.string().date().nullable().optional(),
    paymentTerms: z.string().trim().max(300).nullable().optional(),
    taxCategory: z.enum(["taxable", "reduced", "exempt"]).optional(),
    notes: z.string().trim().max(2000).nullable().optional()
  });
  router.patch("/conditions/:id",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const patch = economicsSchema.parse(req.body ?? {});
      res.json(await conditionWrites.updateEconomics(Number(req.params.id), patch, actor(res)));
    }));

  const scopesSchema = z.object({
    scopes: z.array(z.object({
      scopeType: z.enum(["region", "language", "media", "channel"]),
      label: z.string().trim().min(1).max(120),
      code: z.string().trim().max(20).nullable().optional()
    })).max(200)
  });
  router.put("/conditions/:id/scopes",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { scopes } = scopesSchema.parse(req.body ?? {});
      res.json(await conditionWrites.replaceScopes(
        Number(req.params.id),
        scopes.map((s) => ({ ...s, code: s.code ?? null })),
        actor(res)));
    }));

  // ---- 作品 ----
  router.get("/works", asyncRoute(async (req, res) => {
    res.json({ works: await works.list(String(req.query.q ?? "")) });
  }));

  router.get("/works/:id/envelope", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const envelope = await works.envelope(id);
    if (!envelope) return res.status(404).json({ error: "作品が見つかりません" });
    res.json({ envelope, parts: await works.parts(id) });
  }));

  // ---- 文書 ----
  router.get("/document-templates", asyncRoute(async (_req, res) => {
    res.json({ templates: await documents.listTemplates() });
  }));

  router.get("/documents", asyncRoute(async (req, res) => {
    res.json({ documents: await documents.list({
      keyword: String(req.query.q ?? ""),
      status: req.query.status ? String(req.query.status) : undefined,
      matterId: req.query.matterId ? Number(req.query.matterId) : undefined
    }) });
  }));

  router.get("/documents/:id", asyncRoute(async (req, res) => {
    const detail = await documents.find(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: "文書が見つかりません" });
    res.json(detail);
  }));

  const draftSchema = z.object({
    templateKey: z.string().trim().min(1).max(60),
    conditionIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    matterId: z.coerce.number().int().positive().nullable().optional(),
    agreementId: z.coerce.number().int().positive().nullable().optional(),
    manualInputs: z.record(z.string(), z.unknown()).default({})
  });

  // 発行せずに中身と未入力を確認する。
  router.post("/documents/preview",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      const input = draftSchema.parse(req.body ?? {});
      const result = await issues.preview(input);
      res.json({
        html: result.html,
        templateLabel: result.templateLabel,
        missing: result.binding.missing,
        derived: result.binding.derived,
        values: result.binding.values
      });
    }));

  router.post("/documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = draftSchema.parse(req.body ?? {});
      res.status(201).json(await issues.createDraft(input, actor(res)));
    }));

  router.post("/documents/:id/issue",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await issues.issue(Number(req.params.id), actor(res)));
    }));

  router.get("/documents/:id/html", asyncRoute(async (req, res) => {
    const rendered = await issues.renderIssued(Number(req.params.id));
    res.type("html").send(rendered.html);
  }));

  router.get("/documents/:id/pdf", asyncRoute(async (req, res) => {
    const rendered = await issues.renderIssued(Number(req.params.id));
    const buffer = await pdf.render(rendered.html);
    res.type("application/pdf")
       .setHeader("content-disposition",
         `attachment; filename="${rendered.documentNo ?? `document-${req.params.id}`}.pdf"`);
    res.send(buffer);
  }));

  return router;
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  if (error instanceof DomainError) {
    return res.status(statusFor(error.code)).json({ error: error.message, code: error.code, detail: error.detail });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: "入力が正しくありません", issues: error.issues });
  }
  console.error("unhandled error", error);
  return res.status(500).json({ error: "サーバ内部でエラーが発生しました" });
}
