import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { assertComplete, bindVariables, type BindingResult } from "./binding.js";
import { DocumentContextRepository } from "./context-repository.js";
import { DocumentRepository } from "./repository.js";
import { renderDocumentHtml } from "./render.js";
import { buildCandidates, type Candidate } from "./candidates.js";
import { currentYearInTokyo, formatDocumentNumber, nextSequence, normalizePrefix } from "./numbering.js";

export interface DraftInput {
  templateKey: string;
  conditionIds: number[];
  matterId?: number | null;
  agreementId?: number | null;
  manualInputs?: Record<string, unknown>;
  /** 実績。検収書はここの日付と金額を使う。 */
  eventIds?: number[];
  /** 計算結果。計算書は発行の時点でこれが要る。 */
  royalty?: Record<string, unknown> | null;
}

export interface PreviewResult {
  html: string;
  binding: BindingResult;
  templateLabel: string;
  templateVersionId: number;
  /** 入力欄に出す候補。ひな形が供給元を宣言していなくても人が選べる。 */
  candidates: Candidate[];
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
      // 候補は文脈そのものから作る。ひな形の宣言には依らない。
      const partials = await this.repository.partials();
      return {
        html: renderDocumentHtml(template.htmlSource, binding.values, partials),
        binding,
        templateLabel: template.label,
        templateVersionId: template.templateVersionId,
        candidates: buildCandidates(context)
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
  /**
   * 発行。本文はここで確定して rendered_values に凍結する。
   *
   * extra は下書きに保存していない文脈（実績・計算結果）。発行のときにしか
   * 使わないので列を増やさず、作った経路から渡す。計算書は「先に計算 →
   * その値で発行」でないと、本文に金額が載らない。
   */
  async issue(
    documentId: number, actor: string,
    extra: { eventIds?: number[]; royalty?: Record<string, unknown> | null } = {}
  ): Promise<IssuedDocument> {
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
          agreementId: row.agreement_id,
          eventIds: extra.eventIds ?? [],
          royalty: extra.royalty ?? null
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

  /**
   * 発行済み文書の無効化。
   *
   * 行は消さない。発行した事実そのものが記録なので、消すと「何を出したか」を
   * 追えなくなる。status を void にして理由を監査に残す。
   * 保管先（Drive）のファイルにも触らない。外に出したものは取り消せない。
   */
  async void(documentId: number, reason: string, actor: string): Promise<{ id: number; documentNo: string | null }> {
    const note = String(reason ?? "").trim();
    if (!note) {
      throw new DomainError("VALIDATION", "無効にする理由を書いてください。理由なしでは無効にできません");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, document_no, status FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
        const row = head.rows[0] as { id: number; document_no: string | null; status: string } | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status === "void") throw new DomainError("CONFLICT", "この文書はすでに無効です");
        if (row.status === "superseded") {
          throw new DomainError("CONFLICT",
            "差し替え済みの文書は無効にできません。差し替えた新しい版を無効にしてください");
        }

        await client.query(
          "UPDATE documents SET status = 'void' WHERE id = $1", [documentId]);
        await recordAudit(client, {
          actor, action: "document.void", targetType: "document", targetId: documentId,
          detail: { documentNo: row.document_no, from: row.status, reason: note }
        });
        return { id: documentId, documentNo: row.document_no };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 再発行。発行済みの文書を下書きとして作り直す。
   *
   * 元の文書は消さず superseded にし、新しい文書から supersedes_id で繋ぐ。
   * 紐づく条件も引き継ぐので、そのまま発行し直せる。値は発行時に条件から
   * 引き直すため、条件を直してから再発行すれば新しい値で出る。
   */
  /**
   * 作り直し。
   *
   * 条件の紐づけは既定で引き継ぐが、間違った条件を指していたときのために
   * 差し替えられるようにしてある。発行済みの文書そのものは書き換えない
   * （出したものの記録なので）。直す唯一の道がこれになる。
   */
  async reissue(
    documentId: number, reason: string, actor: string,
    conditionIds?: number[]
  ): Promise<{ id: number; supersedesId: number }> {
    const note = String(reason ?? "").trim();
    if (!note) {
      throw new DomainError("VALIDATION", "作り直す理由を書いてください");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT id, document_no, status, template_version_id, matter_id, agreement_id, manual_inputs
             FROM documents WHERE id = $1 FOR UPDATE`, [documentId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status !== "issued") {
          throw new DomainError("CONFLICT",
            `発行済みの文書だけ作り直せます（この文書は ${row.status}）`);
        }
        if (!row.template_version_id) {
          throw new DomainError("VALIDATION",
            "テンプレートを持たない取込文書は作り直せません。新しく登録してください");
        }

        const created = await client.query(
          `INSERT INTO documents (template_version_id, matter_id, agreement_id, status,
                                  manual_inputs, supersedes_id)
           VALUES ($1, $2, $3, 'draft', $4::jsonb, $5) RETURNING id`,
          [row.template_version_id, row.matter_id, row.agreement_id,
           JSON.stringify(row.manual_inputs ?? {}), documentId]);
        const newId = Number((created.rows[0] as { id: number }).id);

        if (conditionIds && conditionIds.length) {
          // 条件を指定し直した。実在と重複だけ確かめて、その並びで繋ぐ。
          const unique = [...new Set(conditionIds.map((n) => Number(n)))];
          const found = await client.query(
            "SELECT id FROM conditions WHERE id = ANY($1::bigint[])", [unique]);
          if (found.rows.length !== unique.length) {
            const known = new Set((found.rows as Array<{ id: number }>).map((r) => Number(r.id)));
            throw new DomainError("NOT_FOUND",
              `条件が見つかりません：${unique.filter((id) => !known.has(id)).join(", ")}`);
          }
          await this.linkConditions(client, newId, unique);
        } else {
          // 既定は引き継ぎ。参照方向は文書→条件なので、行を複製する。
          await client.query(
            `INSERT INTO document_conditions (document_id, condition_id, line_no)
             SELECT $2, condition_id, line_no FROM document_conditions WHERE document_id = $1
             ON CONFLICT (document_id, condition_id) DO NOTHING`, [documentId, newId]);
        }

        await client.query(
          "UPDATE documents SET status = 'superseded' WHERE id = $1", [documentId]);

        await recordAudit(client, {
          actor, action: "document.reissue", targetType: "document", targetId: documentId,
          detail: { documentNo: row.document_no, newDocumentId: newId, reason: note,
                    ...(conditionIds?.length ? { conditionIds } : {}) }
        });
        return { id: newId, supersedesId: documentId };
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
      eventIds: input.eventIds ?? [],
      royalty: input.royalty ?? null,
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
