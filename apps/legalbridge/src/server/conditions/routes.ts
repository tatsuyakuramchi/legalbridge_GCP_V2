import { Router } from "express";
import { z } from "zod";
import { ConditionRepairError, type ConditionLineRepository } from "./repository.js";

const querySchema = z.object({
  q: z.string().optional().default(""),
  limit: z.coerce.number().int().positive().max(1000).optional().default(300)
});

// Cross-cutting condition-lines list (条件明細 横断検索)。読取＋相手方補修（guarded・Phase 17）。
export function createConditionLineRouter(
  conditions: ConditionLineRepository | undefined,
  repairEnabled = false
) {
  const router = Router();

  router.get("/condition-lines/summary", async (_request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const [groups, settlement] = await Promise.all([conditions.summary(), conditions.settlement()]);
      return response.status(200).json({ groups, settlement });
    } catch (error) {
      next(error);
    }
  });

  router.get("/condition-lines", async (request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const { q, limit } = querySchema.parse(request.query);
      const items = await conditions.list(q, limit);
      return response.status(200).json({ items });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  // 重複警告（導線ガード）：ある作品に既に紐づく条件行を返す。
  // /:id より前に登録して literal path を優先させる。
  router.get("/condition-lines/overlap", async (request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const { workId } = z.object({ workId: z.coerce.number().int().positive() }).parse(request.query);
      const overlap = await conditions.overlap(workId);
      return response.status(200).json({ overlap });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  // Registered after /condition-lines/summary so the literal path wins.
  router.get("/condition-lines/:id", async (request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const detail = await conditions.find(id);
      if (!detail) {
        return response.status(404).json({ error: "condition line not found", code: "CONDITION_LINE_NOT_FOUND" });
      }
      return response.status(200).json({ detail });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  // 条件明細の項目単位の編集（2026-09-07）。相手方補修と同じゲート（scope 'condition-repair'・admin/legal）。
  //   PATCH /condition-lines/:id  { conditionName?, currency?, amountExTax?, …, regions?, languages?, documentId? }
  const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
  const nullableMoney = z.union([z.number(), z.string()]).nullable().optional().transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  });
  const nullableDate = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "日付は YYYY-MM-DD").nullable().optional()
    .transform((v) => (v === undefined ? undefined : v || null));
  const nullableId = z.union([z.number().int().positive(), z.string()]).nullable().optional().transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const codedNames = z.array(z.object({
    code: z.string().max(20).nullable().optional().transform((v) => v ?? null),
    name: z.string().trim().min(1).max(120)
  })).max(300).optional();
  const updateSchema = z.object({
    conditionName: z.string().trim().max(300).optional(),
    currency: nullableText(10),
    amountExTax: nullableMoney,
    mgAmount: nullableMoney,
    agAmount: nullableMoney,
    ratePct: nullableMoney,
    termStart: nullableDate,
    termEnd: nullableDate,
    exclusivity: nullableText(40),
    sublicenseAllowed: z.boolean().nullable().optional(),
    paymentScheme: nullableText(40),
    paymentTerms: nullableText(300),
    royaltyBase: nullableText(300),
    deductibleCosts: nullableText(300),
    notes: nullableText(2000),
    transactionKind: nullableText(40),
    workId: nullableId,
    documentId: nullableId,
    parentLicenseConditionId: nullableId,
    // 業務委託: 行種別・税区分・支払方式は作成フォームと同じ選択肢に限定
    lineKind: z.enum(["payment", "expense", "fee"]).nullable().optional(),
    taxCategory: z.enum(["taxable", "reduced", "exempt"]).nullable().optional(),
    materialCode: nullableText(60),
    sourceMaterialId: nullableId,
    counterpartyVendorId: nullableId,
    groupNo: nullableId,
    basePriceLabel: nullableText(200),
    regions: codedNames,
    languages: codedNames
  }).strict();
  router.patch("/condition-lines/:id", async (request, response, next) => {
    try {
      if (!conditions || !repairEnabled) {
        return response.status(503).json({ error: "condition repair is not enabled", code: "CONDITION_REPAIR_UNAVAILABLE" });
      }
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator role is required", code: "CONDITION_REPAIR_ROLE_REQUIRED" });
      }
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const patch = updateSchema.parse(request.body ?? {});
      const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (!Object.keys(cleaned).length) return response.status(400).json({ error: "変更する項目がありません", code: "EMPTY_PATCH" });
      const result = await conditions.update(id, cleaned);
      const detail = await conditions.find(id);
      return response.status(200).json({ ok: true, ...result, detail });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      if (error instanceof ConditionRepairError) {
        return response.status(error.code === "LINE_NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code });
      }
      const pg = error as { code?: string; message?: string };
      if (pg?.code === "42501") return response.status(503).json({ error: "条件明細の更新権限が未付与です（grant 066）", code: "CONDITION_UPDATE_FORBIDDEN_DB" });
      if (pg?.code === "42703") return response.status(400).json({ error: `列が未追加です（${pg.message ?? ""}）`, code: "CONDITION_UPDATE_COLUMN_MISSING" });
      next(error);
    }
  });

  // 相手方の後付け補修（V1遺産データの取引先欠落用）。
  // グローバル書込ガード（scope 'condition-repair'）通過後の二重ゲート＋admin/legal 限定。
  router.patch("/condition-lines/:id/counterparty", async (request, response, next) => {
    try {
      if (!conditions || !repairEnabled) {
        return response.status(503).json({
          error: "condition repair is not enabled",
          code: "CONDITION_REPAIR_UNAVAILABLE"
        });
      }
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({
          error: "legal or administrator role is required",
          code: "CONDITION_REPAIR_ROLE_REQUIRED"
        });
      }
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const { vendorId } = z.object({ vendorId: z.number().int().positive() }).parse(request.body ?? {});
      const result = await conditions.updateCounterparty(id, vendorId);
      return response.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      if (error instanceof ConditionRepairError) {
        const status = error.code === "LINE_NOT_FOUND" ? 404 : 400;
        return response.status(status).json({ error: error.message, code: error.code });
      }
      next(error);
    }
  });

  return router;
}
