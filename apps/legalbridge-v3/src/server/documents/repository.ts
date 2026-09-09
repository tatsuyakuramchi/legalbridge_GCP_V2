import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { parseVariables, type TemplateVariable } from "./binding.js";

export interface DocumentSummary {
  id: number;
  documentNo: string | null;
  status: string;
  templateKey: string | null;
  templateLabel: string | null;
  title: string | null;
  /** 外で作られた文書。ひな形が無いので、作り直しも再レンダリングもできない。 */
  imported: boolean;
  counterparty: string | null;
  matterId: number | null;
  matterNo: string | null;
  conditionCount: number;
  /** 紐づく条件明細。件数ではなく番号を出す（何から出た書類かが分かる）。 */
  conditions: Array<{ id: number; conditionNo: string | null }>;
  /** この版が差し替えた前の版。 */
  supersedesId: number | null;
  /** この版を差し替えた新しい版。あるとき、この版はもう使わない。 */
  supersededById: number | null;
  supersededByNo: string | null;
  issuedAt: string | null;
  storageUrl: string | null;
}

export interface DocumentDetail extends DocumentSummary {
  templateVersionId: number | null;
  agreementId: number | null;
  /** なぜ前の版を差し替えたか。 */
  supersedeReason: string | null;
  renderedValues: Record<string, unknown>;
  manualInputs: Record<string, unknown>;
  /**
   * 結びついている実績。訂正版の下書きは前の版のものを引き継いで出す。
   * これが無いと、訂正のたびに実績を選び直すことになる。
   */
  eventIds: number[];
  conditions: Array<{ id: number; conditionNo: string | null; name: string; lineNo: number }>;
}

export interface TemplateSource {
  templateId: number;
  templateVersionId: number;
  templateKey: string;
  label: string;
  /** 部分テンプレート（他のひな形に差し込む約款など）は 'partial'。 */
  category: string | null;
  numberPrefix: string | null;
  htmlSource: string;
  variables: TemplateVariable[];
}

const LIST_SELECT = `
  d.id, d.document_no, d.status, d.matter_id, d.issued_at, d.storage_url,
  d.supersedes_id,
  v.title, v.counterparty, v.condition_count, t.template_key,
  m.matter_no,
  -- この版を差し替えた新しい版。参照は新→旧の向きしか無いので反転して読む。
  nx.id AS superseded_by_id, nx.document_no AS superseded_by_no,
  -- 条件明細は件数ではなく番号で出す。件数だけでは何に紐づくか分からない。
  (SELECT array_agg(json_build_object('id', c.id, 'conditionNo', c.condition_no)
                    ORDER BY dc.line_no)
     FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
    WHERE dc.document_id = d.id) AS condition_refs,
  -- 取込文書はひな形を持たないので、種別が空欄になる。登録時に入れた種別で埋める。
  COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS template_label,
  -- 同じ理由で件名も空になる。
  COALESCE(v.title, d.manual_inputs->>'title') AS title,
  (d.template_version_id IS NULL) AS imported`;

const LIST_FROM = `
  FROM documents d
  LEFT JOIN v_document_display v ON v.document_id = d.id
  LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id
  LEFT JOIN matters m ON m.id = d.matter_id
  -- 後継は1件だけ引く。結合のままだと、万一2件あったとき一覧の行が増える。
  LEFT JOIN LATERAL (
    SELECT n.id, n.document_no FROM documents n
     WHERE n.supersedes_id = d.id AND n.status <> 'void'
     ORDER BY n.id DESC LIMIT 1
  ) nx ON true`;

function mapSummary(row: Record<string, any>): DocumentSummary {
  return {
    id: Number(row.id),
    documentNo: str(row.document_no),
    status: String(row.status),
    templateKey: str(row.template_key),
    templateLabel: str(row.template_label),
    title: str(row.title),
    imported: row.imported === true,
    counterparty: str(row.counterparty),
    matterId: int(row.matter_id),
    matterNo: str(row.matter_no),
    conditionCount: Number(row.condition_count ?? 0),
    conditions: ((row.condition_refs ?? []) as Array<{ id: number; conditionNo: string | null }>)
      .map((c) => ({ id: Number(c.id), conditionNo: c.conditionNo ?? null })),
    supersedesId: int(row.supersedes_id),
    supersededById: int(row.superseded_by_id),
    supersededByNo: str(row.superseded_by_no),
    issuedAt: row.issued_at ? new Date(String(row.issued_at)).toISOString() : null,
    storageUrl: str(row.storage_url)
  };
}

export class DocumentRepository {
  constructor(private readonly database: Transactable) {}

  /**
   * unlinked を渡すと、条件明細が1件も繋がっていない文書だけを返す。
   * 移行してきた文書はほとんど条件が付いていない（V1 が持っていなかった）。
   * 繋ぎ直す作業は「まだ繋がっていないものを出す」から始まるので、
   * 探す手段が無いと一覧を上から目で追うことになる。
   */
  async list(query: {
    keyword?: string; status?: string; matterId?: number;
    unlinked?: boolean; limit?: number;
  } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.keyword?.trim()) {
      params.push(`%${query.keyword.trim()}%`);
      const i = params.length;
      where.push(`(COALESCE(d.document_no,'') ILIKE $${i} OR COALESCE(v.title,'') ILIKE $${i}
                   OR COALESCE(v.counterparty,'') ILIKE $${i})`);
    }
    if (query.status) { params.push(query.status); where.push(`d.status = $${params.length}`); }
    if (query.matterId) { params.push(query.matterId); where.push(`d.matter_id = $${params.length}`); }
    if (query.unlinked) {
      where.push(`NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)`);
    }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT ${LIST_SELECT} ${LIST_FROM}
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY d.issued_at DESC NULLS FIRST, d.id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map(mapSummary);
    } catch (error) { throw translate(error); }
  }

  async find(id: number): Promise<DocumentDetail | null> {
    const r = await this.database.query(
      `SELECT ${LIST_SELECT}, d.template_version_id, d.agreement_id, d.supersede_reason,
              d.rendered_values, d.manual_inputs
         ${LIST_FROM}
        WHERE d.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    const conditions = await this.database.query(
      `SELECT c.id, c.condition_no, c.name, dc.line_no
         FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
        WHERE dc.document_id = $1 ORDER BY dc.line_no`, [id]);
    // 実績はこの文書のもの。まだ発行していない訂正版は、前の版のものを引き継ぐ。
    const events = await this.database.query(
      `SELECT id FROM condition_events
        WHERE status = 'active' AND document_id = COALESCE($2::bigint, $1::bigint)
        ORDER BY occurred_on, id`,
      [id, row.status === "draft" ? int(row.supersedes_id) : null]);

    return {
      ...mapSummary(row),
      templateVersionId: int(row.template_version_id),
      agreementId: int(row.agreement_id),
      supersedeReason: str(row.supersede_reason),
      eventIds: (events.rows as Array<{ id: number }>).map((e) => Number(e.id)),
      renderedValues: (row.rendered_values as Record<string, unknown>) ?? {},
      manualInputs: (row.manual_inputs as Record<string, unknown>) ?? {},
      conditions: conditions.rows.map((c: Record<string, any>) => ({
        id: Number(c.id), conditionNo: str(c.condition_no),
        name: String(c.name), lineNo: Number(c.line_no)
      }))
    };
  }

  /** テンプレートの現行版。発行済み文書の再描画は版を固定して引く。 */
  async templateSource(client: Queryable, options: { templateKey?: string; versionId?: number }): Promise<TemplateSource> {
    const r = options.versionId
      ? await client.query(
          `SELECT t.id AS template_id, tv.id AS version_id, t.template_key, t.label,
                  t.category, t.number_prefix, tv.html_source, tv.variables
             FROM document_template_versions tv JOIN document_templates t ON t.id = tv.template_id
            WHERE tv.id = $1`, [options.versionId])
      : await client.query(
          `SELECT t.id AS template_id, tv.id AS version_id, t.template_key, t.label,
                  t.category, t.number_prefix, tv.html_source, tv.variables
             FROM document_templates t JOIN document_template_versions tv ON tv.id = t.current_version_id
            WHERE t.template_key = $1 AND t.is_active`, [options.templateKey]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) {
      throw new DomainError("NOT_FOUND",
        options.versionId
          ? `テンプレートの版 ${options.versionId} が見つかりません`
          : `テンプレート ${options.templateKey} が見つかりません`);
    }
    return {
      templateId: Number(row.template_id),
      templateVersionId: Number(row.version_id),
      templateKey: String(row.template_key),
      label: String(row.label),
      category: str(row.category),
      numberPrefix: str(row.number_prefix),
      htmlSource: String(row.html_source),
      variables: parseVariables(row.variables)
    };
  }

  async listTemplates() {
    const r = await this.database.query(
      `SELECT t.id, t.template_key, t.label, t.category, t.number_prefix,
              tv.id AS version_id, tv.version_no
         FROM document_templates t
         -- 版の無いひな形は選ばせない。選択肢に出すと、選んだ瞬間に
         -- 「テンプレートが見つかりません」で下書きも作れない行になる。
         JOIN document_template_versions tv ON tv.id = t.current_version_id
        WHERE t.is_active
          -- 部分テンプレートは他のひな形に差し込むもので、単独では発行できない。
          AND t.category IS DISTINCT FROM 'partial'
          AND t.template_key NOT LIKE '\\_%'
        ORDER BY t.category NULLS LAST, t.label`);
    return r.rows.map((t: Record<string, any>) => ({
      id: Number(t.id), templateKey: String(t.template_key), label: String(t.label),
      category: str(t.category), numberPrefix: str(t.number_prefix),
      versionId: int(t.version_id), versionNo: int(t.version_no)
    }));
  }

  /**
   * 差し込み用の部分テンプレート。
   *
   * V2 は kind='partial' で持ち、名前は template_key そのもの
   * （{{> terms_spot_2026}}）。V3 は移行でそれを category に写している。
   * ここを template_key の "_" 始まりで探していたため1件も見つからず、
   * 部分を差し込むひな形が「The partial ... could not be found」で
   * 全部落ちていた。
   *
   * "_" 始まりの規約も残す。どちらの名前でも引けるようにしておく。
   */
  async partials(): Promise<Record<string, string>> {
    const r = await this.database.query(
      `SELECT t.template_key, tv.html_source
         FROM document_templates t JOIN document_template_versions tv ON tv.id = t.current_version_id
        WHERE t.is_active
          AND (t.category = 'partial' OR t.template_key LIKE '\\_%')`);
    const out: Record<string, string> = {};
    for (const row of r.rows as Array<Record<string, any>>) {
      const key = String(row.template_key);
      const html = String(row.html_source);
      out[key] = html;
      if (key.startsWith("_")) out[key.slice(1)] = html;
    }
    return out;
  }
}

export { dateStr };
