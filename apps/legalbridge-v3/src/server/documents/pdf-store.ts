import { createHash } from "node:crypto";
import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import type { PdfRenderer } from "./pdf-renderer.js";

/**
 * 決定した文書の PDF の作り置き（A-065）。
 *
 * 送るたび・開くたびに Chromium で描いていたので、メールも CloudSign も
 * 押してから 10〜20 秒かかっていた。決定した文書の本文は変わらない
 * （rendered_values とひな形の版が固定）ので、決定した瞬間に 1 度描いて
 * document_pdfs に置き、以後はそれを返す。
 *
 *   - 決定の後に warm（失敗しても決定は取り消さない。次に使うときに描く）
 *   - 使うときは ensure（無ければ描いて置く）
 *   - 取込文書は Drive のファイルが実体なので、ここには置かない
 */
export class PdfStore {
  constructor(
    private readonly database: Queryable,
    private readonly renderer: PdfRenderer,
    private readonly renderHtml: (documentId: number) => Promise<{ html: string; documentNo: string | null }>,
    private readonly rendererName = "chromium",
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {}

  /** 置いてある PDF。無ければ null。 */
  async get(documentId: number): Promise<Buffer | null> {
    const r = await this.database.query(
      "SELECT data FROM document_pdfs WHERE document_id = $1", [documentId]);
    const row = r.rows[0] as { data?: Buffer | Uint8Array } | undefined;
    return row?.data ? Buffer.from(row.data) : null;
  }

  /** 置いてあればそれ、無ければ描いて置いてから返す。 */
  async ensure(documentId: number): Promise<Buffer> {
    const cached = await this.get(documentId);
    if (cached) return cached;
    return this.render(documentId);
  }

  /** 決定の直後に描いて置く。失敗しても決定は成り立っているので、知らせるだけ。 */
  async warm(documentId: number): Promise<boolean> {
    try {
      await this.render(documentId);
      return true;
    } catch (error) {
      this.log(`PDF の作り置きに失敗（文書 ${documentId}）：${(error as Error).message}。次に使うときに描きます`);
      return false;
    }
  }

  /** 置いてあるものを捨てる（本文を描き直す必要が出たとき）。 */
  async invalidate(documentId: number): Promise<void> {
    await this.database.query("DELETE FROM document_pdfs WHERE document_id = $1", [documentId]);
  }

  /** まだ置いていない決定済みの文書（取込文書を除く）。古いものから。 */
  async missing(limit = 50): Promise<number[]> {
    const r = await this.database.query(
      `SELECT d.id FROM documents d
        WHERE d.status IN ('issued', 'superseded') AND d.template_version_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM document_pdfs p WHERE p.document_id = d.id)
        ORDER BY d.id DESC LIMIT $1`, [limit]);
    return (r.rows as Array<{ id: number }>).map((x) => Number(x.id));
  }

  private async render(documentId: number): Promise<Buffer> {
    const rendered = await this.renderHtml(documentId);
    const data = await this.renderer.render(rendered.html);
    if (!data?.length) throw new DomainError("CONFLICT", "PDF を描けませんでした（空）");
    const sha256 = createHash("sha256").update(data).digest("hex");
    await this.database.query(
      `INSERT INTO document_pdfs (document_id, data, bytes, sha256, renderer, rendered_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (document_id) DO UPDATE
         SET data = EXCLUDED.data, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
             renderer = EXCLUDED.renderer, rendered_at = now()`,
      [documentId, data, data.length, sha256, this.rendererName]);
    return data;
  }
}
