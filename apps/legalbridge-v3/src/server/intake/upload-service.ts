import { createHmac, timingSafeEqual } from "node:crypto";
import { inTransaction, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { recordCommunication } from "../matters/communication-service.js";
import type { DriveStorage } from "../documents/drive-storage.js";

/**
 * 依頼者の資料アップロード（A-055）。V1 の /attachments/upload の置き換え。
 *
 * 依頼者は V3 に入れない。だから署名付きのリンク（30 日有効）を渡し、そのリンクの
 * ページから資料を上げてもらう。リンクは依頼（受付箱）か案件に結び付いていて、
 * 上がった資料はそこに繋がる。ファイルは Drive、記録は requester_uploads。
 * 案件に上がったものは案件の「やり取り」にも Drive のファイルとして残る。
 *
 * 署名：HMAC-SHA256(UPLOAD_SIGNING_SECRET, "<種類>:<ID>:<期限>")（V1 と同じ方式）。
 * 秘密が無ければリンクを作らない・受け付けない（fail-closed）。
 */

export type UploadTarget = "r" | "m";   // r=依頼（受付箱） m=案件
export const UPLOAD_KINDS = ["counterparty_draft", "own_draft", "reference"] as const;
export type UploadKind = typeof UPLOAD_KINDS[number];
export const UPLOAD_KIND_LABEL: Record<UploadKind, string> = {
  counterparty_draft: "相手方ドラフト（レビュー対象）", own_draft: "自社ドラフト", reference: "参考資料"
};
export const UPLOAD_TTL_SECONDS = 30 * 24 * 60 * 60;
export const UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

export interface UploadRecord {
  id: number; uploadNo: string; kind: UploadKind; fileName: string; mimeType: string | null;
  sizeBytes: number | null; driveUrl: string | null; uploaderEmail: string | null; note: string | null;
  uploadedAt: string; intakeRequestId: number | null; matterId: number | null;
}

const sign = (secret: string, target: UploadTarget, id: number, exp: number) =>
  createHmac("sha256", secret).update(`${target}:${id}:${exp}`).digest("base64url");

/** リンクの鍵。「種類.ID.期限.署名」。 */
export function makeUploadToken(secret: string, target: UploadTarget, id: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + UPLOAD_TTL_SECONDS;
  return `${target}.${id}.${exp}.${sign(secret, target, id, exp)}`;
}

/** 鍵を確かめる。期限切れ・改ざんは理由つきで断る。 */
export function verifyUploadToken(secret: string, token: string, now = Date.now()): { target: UploadTarget; id: number } {
  if (!secret) throw new DomainError("FORBIDDEN", "アップロードは受け付けていません（設定がありません）");
  const m = /^([rm])\.(\d{1,12})\.(\d{9,11})\.([A-Za-z0-9_-]{20,})$/.exec(String(token ?? "").trim());
  if (!m) throw new DomainError("FORBIDDEN", "リンクが正しくありません。法務から届いたリンクをそのまま開いてください");
  const [, target, idText, expText, sig] = m;
  const expected = Buffer.from(sign(secret, target as UploadTarget, Number(idText), Number(expText)));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new DomainError("FORBIDDEN", "リンクが正しくありません。法務から届いたリンクをそのまま開いてください");
  }
  if (Number(expText) * 1000 < now) {
    throw new DomainError("FORBIDDEN", "リンクの有効期限（30 日）が切れています。法務に新しいリンクを頼んでください");
  }
  return { target: target as UploadTarget, id: Number(idText) };
}

/** ファイル名を Drive に置ける形に。パスや制御文字を落とす。 */
export function safeFileName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return cleaned || "file";
}

export interface UploadServiceOptions {
  secret: string;
  /** 外から開けるこのサービスの URL（例 https://legal.example.com）。リンクを作るのに使う。 */
  publicBaseUrl: string;
}

export class RequesterUploadService {
  constructor(
    private readonly database: Transactable,
    private readonly drive: DriveStorage | null,
    private readonly options: UploadServiceOptions
  ) {}

  get enabled() { return Boolean(this.options.secret && this.options.publicBaseUrl); }

  /** 依頼か案件のアップロード用リンク。設定が無ければ理由つきで null。 */
  link(target: UploadTarget, id: number): { url: string | null; reason?: string; expiresInDays: number } {
    if (!this.options.secret) return { url: null, reason: "UPLOAD_SIGNING_SECRET が未設定です", expiresInDays: 30 };
    if (!this.options.publicBaseUrl) return { url: null, reason: "PUBLIC_BASE_URL が未設定です", expiresInDays: 30 };
    const base = this.options.publicBaseUrl.replace(/\/+$/, "");
    return { url: `${base}/internal/upload?t=${makeUploadToken(this.options.secret, target, id)}`, expiresInDays: 30 };
  }

  verify(token: string) { return verifyUploadToken(this.options.secret, token); }

  /** リンクの先が何か（アップロードのページの見出し）。 */
  async describe(target: UploadTarget, id: number): Promise<{ label: string; title: string }> {
    const r = target === "r"
      ? await this.database.query(
          `SELECT r.request_no AS no, r.title, r.state, m.matter_no
             FROM intake_requests r LEFT JOIN matters m ON m.id = r.matter_id WHERE r.id = $1`, [id])
      : await this.database.query("SELECT matter_no AS no, title, status AS state FROM matters WHERE id = $1", [id]);
    const row = r.rows[0] as any;
    if (!row) throw new DomainError("NOT_FOUND", "リンクの先の依頼が見つかりません");
    if (target === "r" && ["dismissed", "duplicate"].includes(String(row.state))) {
      throw new DomainError("FORBIDDEN", "この依頼は受付を終えています。資料は法務に直接送ってください");
    }
    return { label: String(row.matter_no ?? row.no ?? `#${id}`), title: String(row.title) };
  }

  async store(
    target: { target: UploadTarget; id: number },
    file: { name: string; mimeType: string; data: Buffer },
    meta: { kind?: string; uploaderEmail?: string | null; note?: string | null }
  ): Promise<UploadRecord> {
    if (!this.drive || typeof this.drive.uploadFile !== "function") {
      throw new DomainError("UNAVAILABLE", "資料の保存先（Drive）が設定されていません。法務に直接送ってください");
    }
    if (!file.data.length) throw new DomainError("VALIDATION", "空のファイルは上げられません");
    if (file.data.length > UPLOAD_MAX_BYTES) throw new DomainError("VALIDATION", "1 ファイル 30MB までです");
    const kind = (UPLOAD_KINDS as readonly string[]).includes(String(meta.kind)) ? meta.kind as UploadKind : "reference";
    const email = str(meta.uploaderEmail)?.trim().slice(0, 200) || null;
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new DomainError("VALIDATION", "メールアドレスの形が正しくありません");
    const name = safeFileName(file.name);

    try {
      // リンクの先を確かめ、依頼が案件になっていれば案件にも繋ぐ。
      const where = await this.database.query(
        target.target === "r"
          ? "SELECT r.id AS request_id, r.matter_id, r.request_no AS label FROM intake_requests r WHERE r.id = $1"
          : "SELECT NULL::bigint AS request_id, m.id AS matter_id, m.matter_no AS label FROM matters m WHERE m.id = $1",
        [target.id]);
      const w = where.rows[0] as any;
      if (!w) throw new DomainError("NOT_FOUND", "リンクの先の依頼が見つかりません");
      const requestId = w.request_id ? Number(w.request_id) : null;
      const matterId = w.matter_id ? Number(w.matter_id) : null;

      const stored = await this.drive.uploadFile({
        filename: `${w.label ?? target.id}_${name}`, mimeType: file.mimeType || "application/octet-stream", data: file.data
      });

      const id = await inTransaction(this.database, async (client) => {
        const no = await allocateNumber(client, { prefix: "ATT", table: "requester_uploads", column: "upload_no", width: 5 });
        const r = await client.query(
          `INSERT INTO requester_uploads (upload_no, intake_request_id, matter_id, kind, file_name, mime_type, size_bytes,
                                          drive_file_id, drive_url, uploader_email, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [no, requestId, matterId, kind, name, file.mimeType || null, file.data.length,
           stored.id, stored.webViewLink, email, str(meta.note)?.trim().slice(0, 1000) || null]);
        const newId = Number((r.rows[0] as any).id);
        if (matterId) await recordUploadOnMatter(client, matterId, { no, name, kind, email, stored });
        await recordAudit(client, {
          actor: email ? `requester:${email}` : "requester:upload-link", action: "upload.store",
          targetType: requestId ? "intake_request" : "matter", targetId: requestId ?? matterId,
          detail: { uploadNo: no, fileName: name, kind, size: file.data.length, driveFileId: stored.id }
        });
        return newId;
      });
      return (await this.list({ uploadId: id }))[0];
    } catch (error) { throw translate(error); }
  }

  async list(filter: { requestId?: number; matterId?: number; uploadId?: number }): Promise<UploadRecord[]> {
    const where = filter.uploadId ? "id = $1" : filter.requestId ? "intake_request_id = $1" : "matter_id = $1";
    const r = await this.database.query(
      `SELECT * FROM requester_uploads WHERE ${where} ORDER BY uploaded_at DESC, id DESC LIMIT 200`,
      [filter.uploadId ?? filter.requestId ?? filter.matterId]);
    return (r.rows as any[]).map((x) => ({
      id: Number(x.id), uploadNo: String(x.upload_no), kind: x.kind as UploadKind, fileName: String(x.file_name),
      mimeType: str(x.mime_type), sizeBytes: x.size_bytes === null ? null : Number(x.size_bytes),
      driveUrl: str(x.drive_url), uploaderEmail: str(x.uploader_email), note: str(x.note),
      uploadedAt: new Date(x.uploaded_at).toISOString(),
      intakeRequestId: x.intake_request_id ? Number(x.intake_request_id) : null,
      matterId: x.matter_id ? Number(x.matter_id) : null
    }));
  }

}

/** 案件の「やり取り」に Drive のファイルとして残す（同じファイルは二度書かない）。 */
async function recordUploadOnMatter(
  client: Queryable, matterId: number,
  x: { no: string; name: string; kind: string; email: string | null; stored: { id: string | null; webViewLink: string | null } }
) {
  if (!x.stored.id) return;
  await recordCommunication(client, {
    matterId, channel: "drive", direction: "in", actor: x.email ? `requester:${x.email}` : "requester:upload-link",
    counterpart: x.email, subject: `${x.no} ${x.name}`,
    body: `依頼者がアップロード（${UPLOAD_KIND_LABEL[x.kind as UploadKind] ?? x.kind}）`,
    externalRef: x.stored.id, externalUrl: x.stored.webViewLink, evidence: { fileId: x.stored.id, uploadNo: x.no }
  });
}

/**
 * 依頼が案件になったとき、それまでに上がった資料を案件にも繋ぐ（受付箱の受付で呼ぶ）。
 * 表がまだ無い（A-055 を流す前）なら何もしない。
 */
export async function attachUploadsToMatter(client: Queryable, requestId: number, matterId: number): Promise<number> {
  const exists = await client.query("SELECT to_regclass('requester_uploads') IS NOT NULL AS ok");
  if (!(exists.rows[0] as any)?.ok) return 0;
  const r = await client.query(
    `UPDATE requester_uploads SET matter_id = $2
      WHERE intake_request_id = $1 AND matter_id IS NULL
      RETURNING upload_no, file_name, kind, uploader_email, drive_file_id, drive_url`, [requestId, matterId]);
  for (const x of r.rows as any[]) {
    await recordUploadOnMatter(client, matterId, {
      no: String(x.upload_no), name: String(x.file_name), kind: String(x.kind), email: str(x.uploader_email),
      stored: { id: str(x.drive_file_id), webViewLink: str(x.drive_url) }
    });
  }
  return r.rowCount ?? 0;
}
