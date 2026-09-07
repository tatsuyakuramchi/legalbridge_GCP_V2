import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { assertComplete, bindVariables, type BindingResult } from "./binding.js";
import { DocumentContextRepository } from "./context-repository.js";
import { DocumentRepository } from "./repository.js";
import { renderDocumentHtml } from "./render.js";
import { currentYearInTokyo, formatDocumentNumber, nextSequence, normalizePrefix } from "./numbering.js";

export interface DraftInput {
  templateKey: string;
  conditionIds: number[];
  matterId?: number | null;
  agreementId?: number | null;
  manualInputs?: Record<string, unknown>;
}

export interface PreviewResult {
  html: string;
  binding: BindingResult;
  templateLabel: string;
  templateVersionId: number;
}

export interface IssuedDocument {
  id: number;
  documentNo: string;
  templateVersionId: number;
  issuedAt: string;
  conditionIds: number[];
}

/**
 * 文書の作成と発行。
 *
 * V2 との違いは値の出どころだけで、採番形式・テンプレート本文・Handlebars ヘルパは
 * そのまま踏襲する（互換境界）。文書は条件を参照する側なので、
 * 発行しても条件は動かさない。
 */
export class DocumentIssueService {
  private readonly repository: DocumentRepository;
  private readonly contexts: DocumentContextRepository;

  constructor(private readonly database: Transactable) {
    this.repository = new DocumentRepository(database);
    this.contexts = new DocumentContextRepository(database);
  }

  /** 発行せずに中身を確認する。必須の未入力もここで分かる。 */
  async preview(input: DraftInput): Promise<PreviewResult> {
    try {
      const template = await this.repository.templateSource(this.database, { templateKey: input.templateKey });
      const context = await this.buildContext(this.database, input, null);
      const binding = bindVariables(template.variables, context, input.manualInputs ?? {});
      const partials = await this.repository.partials();
      return {
        html: renderDocumentHtml(template.htmlSource, binding.values, partials),
        binding,
        templateLabel: template.label,
        templateVersionId: template.templateVersionId
      };
    } catch (error) { throw translate(error); }
  }

  /** 下書きの作成。番号は振らない。 */
  async createDraft(input: DraftInput, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const template = await this.repository.templateSource(client, { templateKey: input.templateKey });
        await this.assertConditionsIssuable(client, input.conditionIds);
        const inserted = await client.query(
          `INSERT INTO documents (template_version_id, matter_id, agreement_id, status, manual_inputs)
           VALUES ($1, $2, $3, 'draft', $4::jsonb) RETURNING id`,
          [template.templateVersionId, input.matterId ?? null, input.agreementId ?? null,
           JSON.stringify(input.manualInputs ?? {})]
        );
        const id = Number((inserted.rows[0] as { id: number }).id);
        await this.linkConditions(client, id, input.conditionIds);
        await recordAudit(client, {
          actor, action: "document.draft", targetType: "document", targetId: id,
          detail: { templateKey: input.templateKey, conditions: input.conditionIds }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 発行。採番して確定値を焼き付ける。
   * 焼き付けた値（rendered_values）は記録であって参照元ではない。
   */
  async issue(documentId: number, actor: string): Promise<IssuedDocument> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT id, status, template_version_id, matter_id, agreement_id, manual_inputs
             FROM documents WHERE id = $1 FOR UPDATE`, [documentId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status !== "draft") {
          throw new DomainError("CONFLICT", `この文書はすでに ${row.status} です`);
        }
        if (!row.template_version_id) {
          throw new DomainError("VALIDATION", "テンプレートが設定されていない文書は発行できません");
        }

        const template = await this.repository.templateSource(client, {
          versionId: Number(row.template_version_id)
        });
        const linked = await client.query(
          "SELECT condition_id FROM document_conditions WHERE document_id = $1 ORDER BY line_no",
          [documentId]);
        const conditionIds = linked.rows.map((c) => Number((c as { condition_id: number }).condition_id));
        await this.assertConditionsIssuable(client, conditionIds);

        const prefix = normalizePrefix(template.numberPrefix);
        if (!prefix) {
          throw new DomainError("VALIDATION",
            `テンプレート ${template.templateKey} に採番プレフィックスが設定されていません`);
        }
        const year = currentYearInTokyo();
        const documentNo = formatDocumentNumber(prefix, year, await nextSequence(client, prefix, year));

        const context = await this.buildContext(client, {
          templateKey: template.templateKey,
          conditionIds,
          matterId: row.matter_id,
          agreementId: row.agreement_id
        }, documentNo);
        const binding = bindVariables(
          template.variables, context, (row.manual_inputs as Record<string, unknown>) ?? {});
        assertComplete(binding);

        const updated = await client.query(
          `UPDATE documents
              SET document_no = $2, status = 'issued', rendered_values = $3::jsonb,
                  issued_at = now(), issued_by = $4
            WHERE id = $1 AND status = 'draft'
            RETURNING issued_at`,
          [documentId, documentNo, JSON.stringify(binding.values), actor]
        );
        if (!updated.rows[0]) throw new DomainError("CONFLICT", "発行中に他の操作と競合しました");

        await recordAudit(client, {
          actor, action: "document.issue", targetType: "document", targetId: documentId,
          detail: { documentNo, templateKey: template.templateKey, conditions: conditionIds }
        });

        return {
          id: documentId,
          documentNo,
          templateVersionId: template.templateVersionId,
          issuedAt: new Date(String((updated.rows[0] as { issued_at: string }).issued_at)).toISOString(),
          conditionIds
        };
      });
    } catch (error) { throw translate(error); }
  }

  /** 発行済み文書を、そのときの版と焼き付けた値で描き直す。 */
  async renderIssued(documentId: number): Promise<{ html: string; documentNo: string | null }> {
    const document = await this.repository.find(documentId);
    if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
    if (!document.templateVersionId) {
      throw new DomainError("VALIDATION", "テンプレートを持たない文書は描画できません");
    }
    const template = await this.repository.templateSource(this.database, {
      versionId: document.templateVersionId
    });
    const partials = await this.repository.partials();
    return {
      html: renderDocumentHtml(template.htmlSource, document.renderedValues, partials),
      documentNo: document.documentNo
    };
  }

  private async buildContext(
    client: Queryable, input: Omit<DraftInput, "manualInputs">, documentNumber: string | null
  ) {
    const context = await this.contexts.build({
      conditionIds: input.conditionIds,
      agreementId: input.agreementId ?? null,
      matterId: input.matterId ?? null,
      documentNumber
    }, client);
    await this.contexts.attachScopes(client, context.conditions);
    return context as unknown as Record<string, unknown>;
  }

  private async linkConditions(client: Queryable, documentId: number, conditionIds: number[]) {
    for (const [index, conditionId] of conditionIds.entries()) {
      await client.query(
        `INSERT INTO document_conditions (document_id, condition_id, line_no)
         VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
        [documentId, conditionId, index + 1]
      );
    }
  }

  /** 無効・旧版の条件からは文書を出さない。 */
  private async assertConditionsIssuable(client: Queryable, conditionIds: number[]) {
    if (!conditionIds.length) return;
    const r = await client.query(
      `SELECT id, condition_no, status FROM conditions
        WHERE id = ANY($1::bigint[]) AND status IN ('void', 'superseded')`,
      [conditionIds]
    );
    if (r.rows.length) {
      const names = r.rows.map((c: Record<string, any>) => c.condition_no ?? `#${c.id}`).join("、");
      throw new DomainError("CONFLICT", `無効または旧版の条件は文書にできません: ${names}`);
    }
  }
}
