import type { DatabasePool } from "../db/pool.js";
import type { DocumentFormSchema, TemplateField } from "../../types.js";
import { INDIVIDUAL_LICENSE_V3_KEY, individualLicenseV3Fields } from "./individual-license-v3.js";

export interface TemplateRepository {
  list(): Promise<DocumentFormSchema[]>;
  findCurrent(templateKey: string): Promise<DocumentFormSchema | null>;
  findPartials(): Promise<Record<string, string>>;
  // 描画ソース。versionId を渡すと、その版（document_template_versions.id）の html_source を返す
  // （確定済み文書は自分の版で再描画する＝テンプレ改訂で既存文書の PDF/Drive/CloudSign が
  // 「stored document template version is not available」で止まらない・2026-09-04）。
  // 該当版が無ければ現行版を返す。
  findRenderSource(templateKey: string, versionId?: number | null): Promise<{
    templateVersionId: number;
    htmlSource: string;
  } | null>;
}

export class PgTemplateRepository implements TemplateRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(): Promise<DocumentFormSchema[]> {
    const result = await this.database.query<TemplateRow>(
      `${BASE_QUERY}
       WHERE dt.kind = 'document' AND dt.is_active = TRUE
       ORDER BY dt.category NULLS LAST, dt.label, dt.template_key`
    );
    return result.rows.map(mapTemplate);
  }

  async findCurrent(templateKey: string): Promise<DocumentFormSchema | null> {
    const result = await this.database.query<TemplateRow>(
      `${BASE_QUERY}
       WHERE dt.template_key = $1
         AND dt.kind = 'document'
         AND dt.is_active = TRUE
       LIMIT 1`,
      [templateKey]
    );
    return result.rows[0] ? mapTemplate(result.rows[0]) : null;
  }

  async findRenderSource(templateKey: string, versionId?: number | null) {
    if (versionId != null) {
      // 文書に刻まれた版をそのまま使う（現行版かどうかは問わない）。
      const stored = await this.database.query<{ id: number; html_source: string }>(
        `SELECT dtv.id, dtv.html_source
           FROM document_template_versions dtv
           JOIN document_templates dt ON dt.id = dtv.template_id
          WHERE dt.template_key = $1 AND dt.kind = 'document' AND dtv.id = $2
          LIMIT 1`,
        [templateKey, versionId]
      );
      if (stored.rows[0]) {
        return { templateVersionId: Number(stored.rows[0].id), htmlSource: stored.rows[0].html_source };
      }
    }
    const result = await this.database.query<TemplateRow>(
      `${BASE_QUERY}
       WHERE dt.template_key = $1
         AND dt.kind = 'document'
         AND dt.is_active = TRUE
       LIMIT 1`,
      [templateKey]
    );
    const row = result.rows[0];
    return row
      ? { templateVersionId: row.template_version_id, htmlSource: row.html_source }
      : null;
  }

  async findPartials() {
    const result = await this.database.query<Pick<TemplateRow, "template_key" | "html_source">>(
      `${BASE_QUERY}
       WHERE dt.kind = 'partial'
         AND dt.is_active = TRUE
       ORDER BY dt.template_key`
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.template_key, row.html_source])
    );
  }
}

interface TemplateRow {
  template_key: string;
  template_version_id: number;
  label: string | null;
  category: string | null;
  field_schema: TemplateField[];
  html_source: string;
}

const BASE_QUERY = `
  SELECT
    dt.template_key,
    dt.current_version_id AS template_version_id,
    dt.label,
    dt.category,
    dtv.field_schema,
    dtv.html_source
  FROM document_templates dt
  JOIN document_template_versions dtv
    ON dtv.id = dt.current_version_id
`;

function mapTemplate(row: TemplateRow): DocumentFormSchema {
  const databaseFields = Array.isArray(row.field_schema) ? row.field_schema : [];
  return {
    templateKey: row.template_key,
    templateVersionId: row.template_version_id,
    label: row.label ?? row.template_key,
    category: row.category ?? undefined,
    fields: row.template_key === INDIVIDUAL_LICENSE_V3_KEY && databaseFields.length === 0
      ? individualLicenseV3Fields
      : databaseFields
  };
}

export class MemoryTemplateRepository implements TemplateRepository {
  constructor(
    private readonly templates: DocumentFormSchema[],
    private readonly htmlSources: Record<string, string> = {
      purchase_order: "<h1>発注書</h1><p>{{PROJECT_TITLE}}</p><p>{{VENDOR_NAME}}</p><p>{{ORDER_DATE}}</p>"
    },
    private readonly partialSources: Record<string, string> = {}
  ) {}

  async list() {
    return this.templates;
  }

  async findCurrent(templateKey: string) {
    return this.templates.find((template) => template.templateKey === templateKey) ?? null;
  }

  // 版ごとの HTML を持てる（テスト用）。無ければ現行版の HTML を返す。
  readonly versionSources = new Map<number, string>();
  async findRenderSource(templateKey: string, versionId?: number | null) {
    if (versionId != null && this.versionSources.has(versionId)) {
      return { templateVersionId: versionId, htmlSource: this.versionSources.get(versionId)! };
    }
    const template = await this.findCurrent(templateKey);
    const htmlSource = this.htmlSources[templateKey];
    return template && htmlSource
      ? { templateVersionId: template.templateVersionId, htmlSource }
      : null;
  }

  async findPartials() {
    return this.partialSources;
  }
}
