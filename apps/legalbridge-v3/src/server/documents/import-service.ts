import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { DriveStorage } from "./drive-storage.js";
import { currentYearInTokyo, formatDocumentNumber, nextSequence } from "./numbering.js";
import { safeFilename } from "./storage-service.js";

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

/** 取込文書の採番。自社で出した文書と混ざらないよう別のプレフィックスにする。 */
const IMPORT_PREFIX = "IMP";

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

  async import(input: ImportInput, actor: string): Promise<ImportResult> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "文書名は必須です");
    if (!this.drive || typeof this.drive.uploadFile !== "function") {
      throw new DomainError("DB_FORBIDDEN",
        "ファイルの保存先が設定されていません（GOOGLE_DRIVE_FOLDER_ID）。" +
        "設定されるまでは文書を取り込めません");
    }
    const { data, mimeType } = input.file;
    if (!data?.length) throw new DomainError("VALIDATION", "ファイルが空です");
    if (data.length > MAX_BYTES) {
      throw new DomainError("VALIDATION",
        `ファイルが大きすぎます（${Math.round(data.length / 1024 / 1024)}MB／上限 25MB）`);
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new DomainError("VALIDATION",
        `この形式は取り込めません（${mimeType}）。PDF・Word・Excel・画像のいずれかにしてください`);
    }

    const conditionIds = [...new Set(input.conditionIds.map((n) => Math.trunc(n)))]
      .filter((n) => n > 0);

    try {
      // 先にファイルを預ける。行を作ってから預けて失敗すると、中身の無い文書が
      // 登録済みとして残る。逆なら、宙に浮くのは Drive のファイル1つで済む。
      const filename = `${safeFilename(title)}${extensionFor(mimeType)}`;
      const stored = await this.drive.uploadFile({ filename, mimeType, data });

      return await inTransaction(this.database, async (client) => {
        await this.assertLinkable(client, conditionIds, input.matterId ?? null);

        const year = currentYearInTokyo();
        const documentNo = formatDocumentNumber(
          IMPORT_PREFIX, year, await nextSequence(client, IMPORT_PREFIX, year));

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

        for (const [index, conditionId] of conditionIds.entries()) {
          await client.query(
            `INSERT INTO document_conditions (document_id, condition_id, line_no)
             VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
            [id, conditionId, index + 1]);
        }

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
