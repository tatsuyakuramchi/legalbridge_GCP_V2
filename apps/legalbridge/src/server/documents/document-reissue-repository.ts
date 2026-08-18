import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.js";
import type { DocumentReissueInput } from "./document-reissue-schema.js";

// 文書の再発行（Phase 10-1b・S-D で V1 準拠に再設計）。既存確定文書を基に新版 <base>-R<n> を
// 採番して INSERT し、旧版を lifecycle_status='reissued'・is_primary=FALSE・superseded_by=<新番号> に倒す。
// 実績（condition_events）は **void ではなく新版へ付け替える（repoint）**：V1 Phase E-1 の
// 「有効実績1件 = final文書1件」不変条件と同じで、再発行しても残高は不変（監査 P0-1）。
//   - 付け替えは document_id のみ。condition_line_id は旧版明細を指したままにする＝残高ビュー
//     （condition_line_status_v）は明細基準なので消化は保たれ、V1 横断検索も「非void 実績を持つ
//     明細」を表示し続ける。V1 の明細付替え（reissueCarryover）は新版に明細を作り直す場合のみの
//     処理で、V2 は新版に明細を作らないため対象が構造的に生じない。
//   - 新版を後から void すれば付け替えた実績ごと取消される（残高復元の導線は void に一本化）。
// grant 034＋041（condition_events.document_id の UPDATE と台帳列名 carried_events は 041）。

export interface DocumentReissueResult {
  sourceId: number;
  sourceNumber: string | null;
  newId: number;
  newNumber: string;
  baseNumber: string;
  carriedEvents: number;
}

export interface DocumentReissueRepository {
  reissue(sourceId: number, input: DocumentReissueInput, actor: string): Promise<DocumentReissueResult>;
}

export class DocumentReissueError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DocumentReissueError";
  }
}

// 新版番号 <base>-R<n> から版数 n を取り出す（PDF の「修正版 Rev. n」バッジ用）。
export function reissueRevisionOf(newNumber: string, base: string): number {
  const rest = newNumber.slice(`${base}-R`.length);
  return /^\d+$/.test(rest) ? Number(rest) : 1;
}

// 再発行する form_data に版数（REVISION）をスタンプする。テンプレートは
// REVISION > 0 のとき「修正版 Rev. n」バッジを出す（検収書ほか）。呼び出し側が
// REVISION を含めていても新版の版数で上書きする（枝番と表示を必ず一致させる）。
export function stampReissueRevision(
  formData: Record<string, unknown>, newNumber: string, base: string
): Record<string, unknown> {
  return { ...formData, REVISION: reissueRevisionOf(newNumber, base) };
}

// 系列の既存番号から次の版番号 <base>-R<n> を決める（純関数・テスト可能）。
export function nextReissueNumber(base: string, existing: Array<string | null | undefined>): string {
  let max = 0;
  const prefix = `${base}-R`;
  for (const n of existing) {
    if (!n) continue;
    if (n === base) continue;               // 元番号＝rev 0
    if (n.startsWith(prefix)) {
      const rest = n.slice(prefix.length);
      if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
    }
  }
  return `${base}-R${max + 1}`;
}

export class PgDocumentReissueRepository implements DocumentReissueRepository {
  constructor(private readonly database: DatabasePool) {}

  async reissue(sourceId: number, input: DocumentReissueInput, actor: string): Promise<DocumentReissueResult> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const source = await lockSource(client, sourceId);
      if (!source) {
        await client.query("ROLLBACK");
        throw new DocumentReissueError("文書が見つかりません", "DOCUMENT_REISSUE_NOT_FOUND");
      }
      if (String(source.lifecycle_status) === "voided") {
        await client.query("ROLLBACK");
        throw new DocumentReissueError("無効化された文書は再発行できません", "DOCUMENT_REISSUE_SOURCE_VOIDED");
      }
      const base = (String(source.base_document_number ?? "").trim() || source.document_number) as string | null;
      if (!base) {
        await client.query("ROLLBACK");
        throw new DocumentReissueError("採番されていない文書は再発行できません", "DOCUMENT_REISSUE_UNNUMBERED");
      }

      // 系列をロックして次版番号を決める。
      const seriesRes = await client.query(
        `SELECT document_number FROM documents
          WHERE COALESCE(NULLIF(base_document_number, ''), document_number) = $1
          FOR UPDATE`,
        [base]
      );
      const newNumber = nextReissueNumber(base, seriesRes.rows.map((r) => r.document_number));
      const formData = stampReissueRevision(input.formData ?? source.form_data ?? {}, newNumber, base);

      // 新版は旧版から業務列（vendor/契約種別/表題/有効期間/台帳参照…）を丸ごと引き継ぐ（監査 P0-4）。
      // 空のまま INSERT すると V1 の tg_doc_autolink_contract が業務列 NULL の contracts 行を捏造し、
      // V1 の契約一覧に取引先・表題空の行が出る。contract_status は V1 既定 'executed' に倒す（P0-3）。
      const inserted = await client.query(
        `INSERT INTO documents (
           document_number, base_document_number, issue_key, template_type, template_version_id,
           form_data, drive_link, created_at, created_by, lifecycle_status, is_primary,
           vendor_id, record_type, contract_category, contract_type, contract_title, contract_status,
           effective_date, expiration_date, auto_renewal, original_work, product_name, work_name,
           media, territory, language, document_url, backlog_issue_key, ledger_code, ledger_ref_id,
           material_ref_id, template_family, flow_direction, deliverable_ownership
         )
         SELECT $1, $2, issue_key, template_type, template_version_id,
                $3::jsonb, '', now(), $4, 'final', true,
                vendor_id, record_type, contract_category, contract_type, contract_title,
                COALESCE(contract_status, 'executed'),
                effective_date, expiration_date, auto_renewal, original_work, product_name, work_name,
                media, territory, language, document_url, backlog_issue_key, ledger_code, ledger_ref_id,
                material_ref_id, template_family, flow_direction, deliverable_ownership
           FROM documents WHERE id = $5
         RETURNING id`,
        [newNumber, base, JSON.stringify(formData), actor, sourceId]
      );
      const newId = Number(inserted.rows[0].id);

      // 系列の同種文書だけを正本から降格（監査 P1-5）。V1 は template_type 単位で正本を選ぶため、
      // 例えば発注書の再発行で同系列の検収書の正本フラグを巻き込まない。
      await client.query(
        `UPDATE documents SET is_primary = false
          WHERE COALESCE(NULLIF(base_document_number, ''), document_number) = $1
            AND template_type = $3 AND id <> $2`,
        [base, newId, source.template_type]
      );
      // 旧版を reissued に倒す（V1 同様 updated_at も進める・grant 039）。
      await client.query(
        `UPDATE documents SET lifecycle_status = 'reissued', superseded_by = $2, updated_at = now()
          WHERE id = $1`,
        [sourceId, newNumber]
      );
      // 旧版（系列全体）の有効実績を新版へ付け替える（V1 Phase E-1 準拠・残高不変）。
      // void ではないので消化済みの発注を再発行しても残額は変わらない（監査 P0-1）。
      const events = await client.query(
        `UPDATE condition_events SET document_id = $2
          WHERE voided_at IS NULL
            AND document_id IN (
              SELECT id FROM documents
               WHERE COALESCE(NULLIF(base_document_number, ''), document_number) = $1
                 AND id <> $2
            )
          RETURNING id`,
        [base, newId]
      );
      const carriedEvents = events.rowCount ?? 0;

      await client.query(
        `INSERT INTO lb_v2_document_reissue_ledger
           (source_id, source_number, new_id, new_number, base_number, carried_events, reason, reissued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sourceId, source.document_number ?? null, newId, newNumber, base, carriedEvents, input.reason?.trim() || null, actor]
      );

      await client.query("COMMIT");
      return { sourceId, sourceNumber: source.document_number ?? null, newId, newNumber, baseNumber: base, carriedEvents };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if ((error as { code?: string })?.code === "42501") {
        throw new DocumentReissueError("文書再発行の権限が付与されていません", "DOCUMENT_REISSUE_FORBIDDEN_DB");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockSource(client: PoolClient, id: number) {
  const result = await client.query(
    `SELECT id, document_number, base_document_number, issue_key, template_type,
            template_version_id, form_data, lifecycle_status
       FROM documents WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return result.rows[0] as
    | {
        id: number; document_number: string | null; base_document_number: string | null;
        issue_key: string; template_type: string; template_version_id: number | null;
        form_data: Record<string, unknown> | null; lifecycle_status: string | null;
      }
    | undefined;
}

// メモリ実装（テスト用）。documents/condition_events を簡易モデル化。
export interface MemoryReissueDoc {
  id: number;
  documentNumber: string | null;
  baseDocumentNumber?: string | null;
  issueKey: string;
  templateType: string;
  templateVersionId: number | null;
  formData: Record<string, unknown>;
  lifecycleStatus: string;
  isPrimary: boolean;
  supersededBy?: string | null;
}
export interface MemoryReissueEvent { id: number; documentId: number; voidedAt: string | null; voidReason: string | null; }

export class MemoryDocumentReissueRepository implements DocumentReissueRepository {
  readonly ledger: DocumentReissueResult[] = [];
  private seq: number;
  constructor(
    private readonly docs: MemoryReissueDoc[] = [],
    private readonly events: MemoryReissueEvent[] = [],
    private readonly forbidden = false
  ) {
    this.seq = Math.max(0, ...docs.map((d) => d.id)) + 1;
  }

  async reissue(sourceId: number, input: DocumentReissueInput, _actor: string): Promise<DocumentReissueResult> {
    if (this.forbidden) throw new DocumentReissueError("文書再発行の権限が付与されていません", "DOCUMENT_REISSUE_FORBIDDEN_DB");
    const source = this.docs.find((d) => d.id === sourceId);
    if (!source) throw new DocumentReissueError("文書が見つかりません", "DOCUMENT_REISSUE_NOT_FOUND");
    if (source.lifecycleStatus === "voided") throw new DocumentReissueError("無効化された文書は再発行できません", "DOCUMENT_REISSUE_SOURCE_VOIDED");
    const base = (source.baseDocumentNumber?.trim() || source.documentNumber) ?? null;
    if (!base) throw new DocumentReissueError("採番されていない文書は再発行できません", "DOCUMENT_REISSUE_UNNUMBERED");

    const series = this.docs.filter((d) => ((d.baseDocumentNumber?.trim() || d.documentNumber) ?? null) === base);
    const newNumber = nextReissueNumber(base, series.map((d) => d.documentNumber));
    const newId = this.seq++;
    this.docs.push({
      id: newId, documentNumber: newNumber, baseDocumentNumber: base, issueKey: source.issueKey,
      templateType: source.templateType, templateVersionId: source.templateVersionId,
      formData: stampReissueRevision(input.formData ?? source.formData, newNumber, base),
      lifecycleStatus: "final", isPrimary: true
    });
    // 同系列でも template_type が異なる文書（例: 検収書）は正本のまま残す（P1-5）。
    for (const d of series) if (d.id !== newId && d.templateType === source.templateType) d.isPrimary = false;
    source.lifecycleStatus = "reissued";
    source.supersededBy = newNumber;
    // 有効実績は void せず新版へ付け替える（残高不変・P0-1）。系列の旧版全体が対象。
    const oldIds = new Set(series.filter((d) => d.id !== newId).map((d) => d.id));
    const affected = this.events.filter((e) => oldIds.has(e.documentId) && e.voidedAt === null);
    for (const e of affected) e.documentId = newId;

    const result = { sourceId, sourceNumber: source.documentNumber, newId, newNumber, baseNumber: base, carriedEvents: affected.length };
    this.ledger.push(result);
    return result;
  }
}
