import { Router } from "express";
import { z } from "zod";
import {
  ConditionLedgerError, type ConditionLedgerRepository, type LedgerSummary
} from "./ledger-repository.js";
import type { ConditionSyncRepository } from "../documents/condition-sync-repository.js";
import { ledgerToConditionInputs, type ConditionLedgerPayload } from "../../condition-ledger.js";

// 条件台帳（condition_ledger）API — 「条件明細を正にする」新フローの保存・再開・文書紐づけ。
//   POST /condition-ledgers           作成（下書き or 確定）→ 条件明細を台帳（condition_lines）へ同期
//   PUT  /condition-ledgers/:id       更新（続きから・下書き→確定）→ 置換同期（実績あり行は保全）
//   GET  /condition-ledgers           一覧（status / workId / vendorId / q）＝続きから・後続文書の入口
//   GET  /condition-ledgers/:id       詳細（payload・条件明細行・紐づく文書）
//   POST /condition-ledgers/:id/attach   {documentId} 過去文書・アップロード文書・確定文書を紐づける
//   POST /condition-ledgers/:id/detach   {documentId} 紐づけ解除
// 書込みは documents スコープ（確定と同じゲート）＋ admin/legal。読取は admin/legal。

const codedName = z.object({ code: z.string().max(20).nullable().optional().transform((v) => v ?? null), name: z.string().trim().max(120) });
const money = z.union([z.number(), z.string()]).nullable().optional().transform((v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
});
const text = (max: number) => z.string().max(max).optional().transform((v) => (v ?? "").trim());
const taxCategory = z.enum(["taxable", "reduced", "exempt"]);

export const ledgerPayloadSchema = z.object({
  entry: z.enum(["new", "work"]).default("new"),
  workId: z.coerce.number().int().positive().nullable().optional().transform((v) => v ?? null),
  workCode: z.string().trim().max(40).nullable().optional().transform((v) => v || null),
  workTitle: text(300),
  vendorId: z.coerce.number().int().positive().nullable().optional().transform((v) => v ?? null),
  vendorName: text(300),
  title: text(300),
  termStart: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "日付は YYYY-MM-DD").optional().transform((v) => v ?? ""),
  termEnd: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "日付は YYYY-MM-DD").optional().transform((v) => v ?? ""),
  kinds: z.array(z.enum(["service", "license_in", "license_out"])).min(1, "条件明細の種類を1つ以上選んでください").max(3),
  payments: z.array(z.object({
    scheme: z.enum(["lump_sum", "installment", "subscription", "per_unit"]).default("lump_sum"),
    materialCode: text(60), name: text(300), amountExTax: money, paymentTerms: text(300),
    deliverableOwnership: text(20)
  })).max(200).default([]),
  expenses: z.array(z.object({
    name: text(300), amountExTax: money, taxCategory: taxCategory.default("taxable"), settlement: text(100)
  })).max(200).default([]),
  fees: z.array(z.object({
    name: text(300), amountExTax: money, taxCategory: taxCategory.default("exempt"), notes: text(300)
  })).max(200).default([]),
  licenseIn: z.array(z.object({
    materialCode: text(60), name: text(300), ratePct: money, mgAmount: money, agAmount: money,
    groupNo: z.coerce.number().int().positive().nullable().optional().transform((v) => v ?? null),
    regions: z.array(codedName).max(300).default([]), languages: z.array(codedName).max(200).default([]),
    basePriceLabel: text(200), paymentTerms: text(300)
  })).max(200).default([]),
  licenseOut: z.array(z.object({
    materialCode: text(60), name: text(300), ratePct: money, mgAmount: money, agAmount: money,
    groupNo: z.coerce.number().int().positive().nullable().optional().transform((v) => v ?? null),
    regions: z.array(codedName).max(300).default([]), languages: z.array(codedName).max(200).default([]),
    basePriceLabel: text(200), paymentTerms: text(300)
  })).max(200).default([]),
  status: z.enum(["draft", "final"]).default("draft"),
  notes: text(2000)
});

const idPath = z.object({ id: z.coerce.number().int().positive() });
const attachBody = z.object({ documentId: z.coerce.number().int().positive() });
const listQuery = z.object({
  status: z.enum(["draft", "final"]).optional(),
  workId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

function canRead(role: string | undefined) { return role === "admin" || role === "legal"; }

export function createConditionLedgerRouter(dependencies: {
  ledgers?: ConditionLedgerRepository;
  conditionSync?: ConditionSyncRepository;
  writeEnabled?: boolean;
}) {
  const { ledgers, conditionSync } = dependencies;
  const writeEnabled = dependencies.writeEnabled === true;
  const router = Router();

  const unavailable = (response: import("express").Response) =>
    response.status(503).json({ error: "condition ledger is not enabled", code: "CONDITION_LEDGER_UNAVAILABLE" });
  const forbidden = (response: import("express").Response) =>
    response.status(403).json({ error: "法務または管理者のみが操作できます", code: "CONDITION_LEDGER_FORBIDDEN" });

  // 台帳（condition_lines）への同期。失敗しても台帳レコードは成立＝再保存で回復できる。
  async function sync(ledger: LedgerSummary, payload: ConditionLedgerPayload) {
    if (!conditionSync) return { conditionSync: null, conditionSyncWarning: "条件明細の同期が構成されていません" };
    try {
      const result = await conditionSync.upsertDocumentConditions(ledger.id, ledgerToConditionInputs(payload));
      return { conditionSync: { written: result.written, deleted: result.deleted }, conditionSyncWarning: undefined };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const warning = code === "42501"
        ? "条件明細の台帳同期権限が未付与です（grant 066）"
        : code === "42703"
          ? "経費・手数料の税区分列が未追加です（infra/gcp/sql/075 を適用してください）。支払・料率行以外は保存されていません"
          : `条件明細の台帳同期に失敗しました（もう一度保存すると再試行します）: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
      return { conditionSync: null, conditionSyncWarning: warning };
    }
  }

  router.get("/condition-ledgers", async (request, response, next) => {
    try {
      if (!ledgers) return unavailable(response);
      if (!canRead(response.locals.currentUser?.role)) return forbidden(response);
      const query = listQuery.parse(request.query);
      return response.json({ ledgers: await ledgers.list(query) });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  router.get("/condition-ledgers/:id", async (request, response, next) => {
    try {
      if (!ledgers) return unavailable(response);
      if (!canRead(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const ledger = await ledgers.find(id);
      if (!ledger) return response.status(404).json({ error: "条件台帳が見つかりません", code: "LEDGER_NOT_FOUND" });
      return response.json({ ledger });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  router.post("/condition-ledgers", async (request, response, next) => {
    try {
      if (!writeEnabled || !ledgers) return unavailable(response);
      if (!canRead(response.locals.currentUser?.role)) return forbidden(response);
      const payload = ledgerPayloadSchema.parse(request.body ?? {}) as ConditionLedgerPayload;
      const actor = response.locals.currentUser?.email ?? null;
      const ledger = await ledgers.create(payload, actor);
      const synced = await sync(ledger, payload);
      return response.status(201).json({ ledger, ...synced });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      if (error instanceof ConditionLedgerError) return response.status(404).json({ error: error.message, code: error.code });
      return next(error);
    }
  });

  router.put("/condition-ledgers/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !ledgers) return unavailable(response);
      if (!canRead(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const payload = ledgerPayloadSchema.parse(request.body ?? {}) as ConditionLedgerPayload;
      const ledger = await ledgers.update(id, payload);
      const synced = await sync(ledger, payload);
      return response.json({ ledger, ...synced });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      if (error instanceof ConditionLedgerError) return response.status(404).json({ error: error.message, code: error.code });
      return next(error);
    }
  });

  router.post("/condition-ledgers/:id/attach", async (request, response, next) => {
    try {
      if (!writeEnabled || !ledgers) return unavailable(response);
      if (!canRead(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const { documentId } = attachBody.parse(request.body ?? {});
      const document = await ledgers.attach(id, documentId);
      return response.json({ document });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      if (error instanceof ConditionLedgerError) {
        return response.status(error.code === "DOCUMENT_IS_LEDGER" ? 409 : 404).json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  });

  router.post("/condition-ledgers/:id/detach", async (request, response, next) => {
    try {
      if (!writeEnabled || !ledgers) return unavailable(response);
      if (!canRead(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const { documentId } = attachBody.parse(request.body ?? {});
      const detached = await ledgers.detach(id, documentId);
      if (!detached) return response.status(404).json({ error: "その文書はこの台帳に紐づいていません", code: "LINK_NOT_FOUND" });
      return response.json({ detached: true });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
