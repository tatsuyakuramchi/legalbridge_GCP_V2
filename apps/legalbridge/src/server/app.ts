import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardSummary, DocumentFormSchema } from "../types.js";
import { buildDocumentFormContext, validateDocumentForm } from "./documents/form-mapper.js";

const dashboard: DashboardSummary = {
  kpis: [
    { label: "対応待ち", value: 12, tone: "warning" },
    { label: "本日期限", value: 4, tone: "danger" },
    { label: "承認待ち", value: 7 },
    { label: "今月完了", value: 38 }
  ],
  stages: [
    { label: "受付", count: 8 },
    { label: "審査", count: 11 },
    { label: "ドラフト", count: 6 },
    { label: "承認・締結", count: 5 },
    { label: "完了", count: 38 }
  ],
  priorities: [
    {
      id: "LB-2026-0148",
      title: "海外ライセンス契約更新",
      counterparty: "North Star Games",
      owner: "法務 田中",
      stage: "審査",
      dueDate: "2026-07-28",
      status: "要確認"
    },
    {
      id: "LB-2026-0144",
      title: "制作業務委託基本契約",
      counterparty: "青空スタジオ",
      owner: "法務 佐藤",
      stage: "ドラフト",
      dueDate: "2026-07-30",
      status: "作成中"
    }
  ]
};

const sampleSchema: DocumentFormSchema = {
  templateKey: "purchase_order",
  templateVersionId: 1,
  label: "発注書（国内）",
  fields: [
    {
      name: "PROJECT_TITLE",
      label: "件名",
      group: "I. 発注概要",
      required: true,
      dbField: "backlog.summary"
    },
    {
      name: "ORDER_DATE",
      label: "発行日",
      type: "date",
      group: "I. 発注概要",
      required: true,
      dbField: "auto.today"
    },
    {
      name: "VENDOR_NAME",
      label: "発注先名称",
      group: "II. 発注先",
      required: true,
      dbField: "vendor.vendor_name"
    },
    {
      name: "SPECIAL_TERMS",
      label: "特約事項",
      type: "textarea",
      group: "III. 特約・備考"
    }
  ]
};

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "legalbridge-worker-v2" });
  });

  app.get("/api/v2/dashboard", (_request, response) => {
    response.json(dashboard);
  });

  app.get("/api/v2/document-templates/:templateKey/form-schema", (request, response) => {
    if (request.params.templateKey !== sampleSchema.templateKey) {
      return response.status(404).json({ error: "template not found" });
    }
    response.json(sampleSchema);
  });

  app.post("/api/v2/documents/validate", (request, response) => {
    const data = buildDocumentFormContext(sampleSchema, {}, request.body?.formData ?? {});
    const errors = validateDocumentForm(sampleSchema.fields, data);
    response.status(errors.length ? 422 : 200).json({ ok: errors.length === 0, errors });
  });

  if (process.env.NODE_ENV === "production") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const clientRoot = path.resolve(here, "../../client");
    app.use(express.static(clientRoot));
    app.get(/.*/, (_request, response) => {
      response.sendFile(path.join(clientRoot, "index.html"));
    });
  }

  return app;
}
