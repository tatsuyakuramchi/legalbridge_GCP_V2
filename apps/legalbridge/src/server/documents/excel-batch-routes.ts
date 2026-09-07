import { Router } from "express";
import { z } from "zod";
import type { ExcelBatchRepository } from "./excel-batch-repository.js";
import { groupExcelBatches, type ExcelBatchGroup } from "./excel-batch-engine.js";
import { ACCOUNTING_SHEET_HEADERS, accountingSheetRow } from "../../accounting-row.js";
import { buildXlsx } from "./xlsx-writer.js";
import { buildZip, type ZipEntry } from "./zip-writer.js";
import type { DocumentRegistryRepository } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import { renderStoredDocumentHtml } from "./document-html-renderer.js";

// V1 互換の束ね出力（2026-09-07）: 旧システムは「検収書_個人_<支払日>.xlsx（シート 検収書(個人)）」と
// 各文書の PDF を 1 つの zip にして経理へ渡していた。同じ形を V2 の集計（今回検収分のみ）から出す。
export interface ExcelBundleDependencies {
  documents?: DocumentRegistryRepository;
  templates?: TemplateRepository;
  pdfRenderer?: PdfRenderer;
  pdfEnabled?: boolean;
}

const CATEGORY_LABEL: Record<ExcelBatchGroup["category"], string> = {
  inspection_certificate: "検収書",
  royalty_statement: "利用許諾料計算書"
};

export function bundleFileStem(category: ExcelBatchGroup["category"], entity: "個人" | "法人", paymentDate: string) {
  return `${CATEGORY_LABEL[category]}_${entity}_${paymentDate || "no-date"}`;
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Excel 一括出力（Phase 10-5）。集計は読取（admin/legal）。発行済みマークは guarded-write
// （capability 'excel-batch'・隔離台帳 grant 035・確認トークン不要＝本番業務表は不変）。
// 帳票（Excel ファイル）自体は client の export-util で生成する（サーバは対象データと集計のみ）。

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが利用できます", code: "EXCEL_BATCH_FORBIDDEN" });
}

const markSchema = z.object({
  documentNumbers: z.array(z.string().trim().min(1).max(120)).min(1).max(1000),
  batchKey: z.string().trim().max(200).optional()
});

const bundleQuerySchema = z.object({
  key: z.string().trim().min(1).max(400),                     // グループキー（種別||担当者||支払期日）
  entity: z.enum(["個人", "法人"]),
  withPdf: z.enum(["1", "0"]).optional().default("1")
});

export function createExcelBatchRouter(
  repository: ExcelBatchRepository | undefined,
  writeEnabled = false,
  bundle: ExcelBundleDependencies = {}
) {
  const router = Router();

  // V1 互換の束ね出力: xlsx（個人／法人ごと・V1 と同じ 53 列）＋ 各文書の PDF を zip で返す。
  // withPdf=0 なら xlsx だけ。読取のみ（発行済み記録はしない）。
  router.get("/documents/excel-batches/bundle", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "excel batch is not available", code: "EXCEL_BATCH_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const query = bundleQuerySchema.parse(request.query);
      const groups = groupExcelBatches(await repository.loadPending(1000));
      const group = groups.find((g) => g.key === query.key);
      if (!group) return response.status(404).json({ error: "対象のグループがありません（再読込してください）", code: "EXCEL_BATCH_GROUP_NOT_FOUND" });
      const items = group.items.filter((item) => item.accounting?.entityType === query.entity);
      if (!items.length) return response.status(404).json({ error: `${query.entity}の文書がこのグループにありません`, code: "EXCEL_BATCH_ENTITY_EMPTY" });

      const stem = bundleFileStem(group.category, query.entity, group.paymentDate);
      const xlsx = buildXlsx([{
        name: `${CATEGORY_LABEL[group.category]}(${query.entity})`,
        rows: [ACCOUNTING_SHEET_HEADERS, ...items.map((item) => accountingSheetRow(item.accounting!))]
      }]);
      if (query.withPdf === "0") {
        return response.status(200)
          .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .setHeader("Content-Disposition", contentDisposition(`${stem}.xlsx`))
          .setHeader("Cache-Control", "no-store")
          .send(xlsx);
      }

      const entries: ZipEntry[] = [{ name: `${stem}.xlsx`, data: xlsx }];
      const skipped: string[] = [];
      const canPdf = Boolean(bundle.pdfEnabled && bundle.documents && bundle.templates && bundle.pdfRenderer);
      for (const item of items) {
        if (!canPdf) { skipped.push(item.documentNumber); continue; }
        try {
          const document = await bundle.documents!.findByNumber(item.documentNumber);
          const html = document ? await renderStoredDocumentHtml(bundle.templates!, document) : null;
          if (!html) { skipped.push(item.documentNumber); continue; }
          entries.push({ name: `${item.documentNumber}.pdf`, data: await bundle.pdfRenderer!.render(html) });
        } catch {
          skipped.push(item.documentNumber);
        }
      }
      if (skipped.length) {
        entries.push({
          name: "PDF未生成.txt",
          data: Buffer.from(`PDF を生成できなかった文書:\n${skipped.join("\n")}\n（PDF 生成が未有効化か、テンプレ版が見つかりません）\n`, "utf8")
        });
      }
      return response.status(200)
        .type("application/zip")
        .setHeader("Content-Disposition", contentDisposition(`${stem}.zip`))
        .setHeader("Cache-Control", "no-store")
        .send(buildZip(entries));
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 未発行の検収書/利用許諾料計算書を 種別×担当者×支払期日 で集計。
  router.get("/documents/excel-batches", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "excel batch is not available", code: "EXCEL_BATCH_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const limit = Number.parseInt(String(request.query.limit ?? "1000"), 10);
      const docs = await repository.loadPending(Number.isFinite(limit) ? limit : 1000);
      const groups = groupExcelBatches(docs);
      return response.status(200).json({ groups, total: docs.length, writeEnabled });
    } catch (error) { return next(error); }
  });

  // 選択文書を発行済みとして記録（保留一覧から除外）。
  router.post("/documents/excel-batches/mark", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "excel batch mark is not enabled", code: "EXCEL_BATCH_WRITE_UNAVAILABLE" });
      }
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const input = markSchema.parse(request.body ?? {});
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      try {
        const recorded = await repository.markExported(input.documentNumbers, input.batchKey ?? "", actor);
        return response.status(200).json({ recorded, requested: input.documentNumbers.length });
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({ error: "Excel 発行台帳の権限が付与されていません", code: "EXCEL_BATCH_FORBIDDEN_DB" });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
