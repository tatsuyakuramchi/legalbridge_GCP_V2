import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { DriveStorage } from "./drive-storage.js";
import { currentYearInTokyo, formatDocumentNumber, nextSequence } from "./numbering.js";
import { safeFilename } from "./storage-service.js";
import { prefixForKind } from "./import-kinds.js";

/**
 * システムの外で作られた文書の登録（取込文書）。
 *
 * documents.template_version_id は最初から NULL を許してあり、スキーマにも
 * 「取込文書（既存契約書のPDF登録）はテンプレートを持たないため NULL を許す」と
 * 書いてある。ところが INSERT を書いているのは下書きの作成と再発行だけで、
 * どちらもひな形を必須にしていた。つまり読む側だけがあって、書く側が無かった。
 *
 * そのせいで
 *   - 案件の「取り込んだ文書」の数が常に 0 だった
 *   - 他社文書レビュー型の段階が永久に完了しなかった
 *     （「受け取った文書を登録する」と出るのに、登録する手段が無い）
 *
 * 取込文書は発行済みとして入れる。下書きにすると、実績への紐付けも
 * CloudSign への送付も受け付けられない（どちらも発行済みを要求する）。
 * 相手方から届いた時点で、こちらにとっては確定した文書なので、下書きの
 * 段階が存在しない。
 */

/*
 * 採番は種別ごとの接頭辞（import-kinds.ts）。自社のひな形で出した文書（PO・RS）
 * とは混ざらない。種別が表に無ければ IMP。
 *
 * 「番号を先に取る」（reserve）は、法務がワンオフで作る文書のため。番号だけを
 * 持つ下書き（template NULL・reserved:true）を作って番号を返し、本文に書き込んで
 * もらってから attachFile でファイルを付けて発行済みにする。
 */

export interface ImportInput {
  /** 文書名。相手方から届いた契約書の題名など。 */
  title: string;
  /** 種別。「業務委託契約書」「発注請書」など。ひな形が無いので自由記述。 */
  documentKind?: string | null;
  conditionIds: number[];
  matterId?: number | null;
  agreementId?: number | null;
  /** 受領日・締結日。空なら今日。 */
  receivedOn?: string | null;
  note?: string | null;
  /** デイリータスクの依頼。付けると依頼に繋がり、作業の進み具合に数えられる。 */
  requestId?: number | null;
  file: { filename: string; mimeType: string; data: Buffer };
}

export interface ReserveInput {
  title: string;
  documentKind: string;
  conditionIds: number[];
  matterId?: number | null;
  agreementId?: number | null;
  requestId?: number | null;
}

export interface AttachInput {
  receivedOn?: string | null;
  note?: string | null;
  file: { filename: string; mimeType: string; data: Buffer };
}

export interface ImportResult {
  id: number;
  documentNo: string;
  storageUrl: string;
  conditionIds: number[];
}

/** 受け付けるファイルの種類。実行できるものは受けない。 */
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png", "image/jpeg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

const MAX_BYTES = 25 * 1024 * 1024;

export class DocumentImportService {
  constructor(
    private readonly database: Transactable,
    private readonly drive: DriveStorage | null
  ) {}

  get configured(): boolean {
    return this.drive !== null && typeof this.drive.uploadFile === "function";
  }

  /** ファイルの検査と保存先の確認。取り込みも、後から付けるときも同じ。 */
  private checkFile(file: ImportInput["file"]): Required<Pick<DriveStorage, "uploadFile">> {
    if (!this.drive || typeof this.drive.uploadFile !== "function") {
      throw new DomainError("DB_FORBIDDEN",
        "ファイルの保存先が設定されていません（GOOGLE_DRIVE_FOLDER_ID）。" +
        "設定されるまでは文書を取り込めません");
    }
    const { data, mimeType } = file;
    if (!data?.length) throw new DomainError("VALIDATION", "ファイルが空です");
    if (data.length > MAX_BYTES) {
      throw new DomainError("VALIDATION",
        `ファイルが大きすぎます（${Math.round(data.length / 1024 / 1024)}MB／上限 25MB）`);
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new DomainError("VALIDATION",
        `この形式は取り込めません（${mimeType}）。PDF・Word・Excel・画像のいずれかにしてください`);
    }
    return this.drive as Required<Pick<DriveStorage, "uploadFile">>;
  }

  private static cleanIds(ids: number[]): number[] {
    return [...new Set(ids.map((n) => Math.trunc(n)))].filter((n) => n > 0);
  }

  private async assignNumber(client: Queryable, documentKind: string | null | undefined): Promise<string> {
    const prefix = prefixForKind(documentKind);
    const year = currentYearInTokyo();
    return formatDocumentNumber(prefix, year, await nextSequence(client, prefix, year));
  }

  private async linkRequest(client: Queryable, id: number, requestId: number | null | undefined, actor: string) {
    if (!requestId) return;
    await client.query(
      `INSERT INTO intake_request_links (request_id, target_type, target_id, created_by)
       VALUES ($1, 'document', $2, $3) ON CONFLICT DO NOTHING`, [requestId, id, actor]);
  }

  /**
   * 番号を先に取る。番号だけの下書き（ファイル待ち）を作って番号を返す。
   * 本文に番号を書き込んでから attachFile でファイルを付ける。使わなければ無効にする。
   */
  async reserve(input: ReserveInput, actor: string)
    : Promise<{ id: number; documentNo: string; conditionIds: number[] }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "文書名は必須です");
    const documentKind = String(input.documentKind ?? "").trim();
    if (!documentKind) throw new DomainError("VALIDATION", "種別を選んでください");
    const conditionIds = DocumentImportService.cleanIds(input.conditionIds ?? []);
    try {
      return await inTransaction(this.database, async (client) => {
        await this.assertLinkable(client, conditionIds, input.matterId ?? null);
        const documentNo = await this.assignNumber(client, documentKind);
        const inserted = await client.query(
          `INSERT INTO documents
             (document_no, template_version_id, matter_id, agreement_id, status, manual_inputs)
           VALUES ($1, NULL, $2, $3, 'draft', $4::jsonb)
           RETURNING id`,
          [documentNo, input.matterId ?? null, input.agreementId ?? null,
           JSON.stringify({ title, documentKind, imported: true, reserved: true, reservedBy: actor })]);
        const id = Number((inserted.rows[0] as { id: number }).id);
        await this.linkConditions(client, id, conditionIds);
        await this.linkRequest(client, id, input.requestId, actor);
        await recordAudit(client, {
          actor, action: "document.reserve", targetType: "document", targetId: id,
          detail: { documentNo, title, documentKind, conditionIds,
                    matterId: input.matterId ?? null, requestId: input.requestId ?? null }
        });
        return { id, documentNo, conditionIds };
      });
    } catch (error) { throw translate(error); }
  }

  /** 先に取った番号の文書にファイルを付けて、発行済みにする。 */
  async attachFile(documentId: number, input: AttachInput, actor: string): Promise<ImportResult> {
    const drive = this.checkFile(input.file);
    const { data, mimeType } = input.file;
    try {
      const head = await this.database.query(
        "SELECT id, document_no, status, template_version_id, manual_inputs FROM documents WHERE id = $1",
        [documentId]);
      const row = head.rows[0] as {
        id: number; document_no: string | null; status: string;
        template_version_id: number | null; manual_inputs: Record<string, unknown> | null;
      } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
      const inputs = (row.manual_inputs ?? {}) as Record<string, unknown>;
      if (row.template_version_id !== null || inputs.reserved !== true || row.status !== "draft") {
        throw new DomainError("CONFLICT",
          row.status === "issued" && row.template_version_id === null
            ? "この文書にはもうファイルが付いています"
            : "番号を先に取った文書（ファイル待ち）にだけファイルを付けられます");
      }
      const title = String(inputs.title ?? row.document_no ?? "document");
      const filename = `${safeFilename(title)}${extensionFor(mimeType)}`;
      const stored = await drive.uploadFile({ filename, mimeType, data });

      return await inTransaction(this.database, async (client) => {
        const updated = await client.query(
          `UPDATE documents
              SET status = 'issued', storage_url = $2,
                  issued_at = COALESCE($3::date, current_date), issued_by = $4,
                  manual_inputs = manual_inputs || $5::jsonb
            WHERE id = $1 AND status = 'draft'
            RETURNING id, document_no`,
          [documentId, stored.webViewLink, input.receivedOn ?? null, actor,
           JSON.stringify({ reserved: false, note: input.note ?? inputs.note ?? null,
                            filename, mimeType, bytes: data.length })]);
        const r = updated.rows[0] as { id: number; document_no: string } | undefined;
        if (!r) throw new DomainError("CONFLICT", "文書の状態が変わりました。開き直してください");
        const links = await client.query(
          "SELECT condition_id FROM document_conditions WHERE document_id = $1 ORDER BY line_no", [documentId]);
        const conditionIds = (links.rows as Array<{ condition_id: number }>).map((x) => Number(x.condition_id));
        await recordAudit(client, {
          actor, action: "document.import", targetType: "document", targetId: documentId,
          detail: { documentNo: r.document_no, title, reserved: true, conditionIds,
                    filename, mimeType, bytes: data.length, fileId: stored.id }
        });
        return { id: documentId, documentNo: r.document_no, storageUrl: stored.webViewLink, conditionIds };
      });
    } catch (error) { throw translate(error); }
  }

  async import(input: ImportInput, actor: string): Promise<ImportResult> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "文書名は必須です");
    const drive = this.checkFile(input.file);
    const { data, mimeType } = input.file;
    const conditionIds = DocumentImportService.cleanIds(input.conditionIds);

    try {
      // 先にファイルを預ける。行を作ってから預けて失敗すると、中身の無い文書が
      // 登録済みとして残る。逆なら、宙に浮くのは Drive のファイル1つで済む。
      const filename = `${safeFilename(title)}${extensionFor(mimeType)}`;
      const stored = await drive.uploadFile({ filename, mimeType, data });

      return await inTransaction(this.database, async (client) => {
        await this.assertLinkable(client, conditionIds, input.matterId ?? null);
        const documentNo = await this.assignNumber(client, input.documentKind);

        const inserted = await client.query(
          `INSERT INTO documents
             (document_no, template_version_id, matter_id, agreement_id, status,
              manual_inputs, storage_url, issued_at, issued_by)
           VALUES ($1, NULL, $2, $3, 'issued', $4::jsonb, $5,
                   COALESCE($6::date, current_date), $7)
           RETURNING id`,
          [documentNo, input.matterId ?? null, input.agreementId ?? null,
           JSON.stringify({
             title, documentKind: input.documentKind ?? null,
             note: input.note ?? null, filename, mimeType, bytes: data.length,
             imported: true
           }),
           stored.webViewLink, input.receivedOn ?? null, actor]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await this.linkConditions(client, id, conditionIds);
        await this.linkRequest(client, id, input.requestId, actor);

        await recordAudit(client, {
          actor, action: "document.import", targetType: "document", targetId: id,
          detail: { documentNo, title, documentKind: input.documentKind ?? null,
                    conditionIds, matterId: input.matterId ?? null,
                    filename, mimeType, bytes: data.length, fileId: stored.id }
        });

        return { id, documentNo, storageUrl: stored.webViewLink, conditionIds };
      });
    } catch (error) { throw translate(error); }
  }

  private async linkConditions(client: Queryable, id: number, conditionIds: number[]) {
    for (const [index, conditionId] of conditionIds.entries()) {
      await client.query(
        `INSERT INTO document_conditions (document_id, condition_id, line_no)
         VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
        [id, conditionId, index + 1]);
    }
  }

  /** 繋ぎ先が実在するか。存在しない条件に繋ぐと、あとから辿れない文書になる。 */
  private async assertLinkable(
    client: Queryable, conditionIds: number[], matterId: number | null
  ) {
    if (conditionIds.length) {
      const found = await client.query(
        "SELECT id FROM conditions WHERE id = ANY($1::bigint[])", [conditionIds]);
      if (found.rows.length !== conditionIds.length) {
        throw new DomainError("NOT_FOUND", "存在しない条件が指定されています");
      }
    }
    if (matterId) {
      const m = await client.query("SELECT id FROM matters WHERE id = $1", [matterId]);
      if (!m.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);
    }
  }
}

function extensionFor(mimeType: string): string {
  return ({
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx"
  } as Record<string, string>)[mimeType] ?? "";
}
