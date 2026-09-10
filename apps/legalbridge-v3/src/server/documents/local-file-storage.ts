import fs from "node:fs";
import path from "node:path";
import { DomainError } from "../core/errors.js";
import type { DriveStorage, StoredDriveFile } from "./drive-storage.js";

/**
 * Drive の代わりにローカルのフォルダへ置く保存先（予備系・開発用）。
 *
 * 本番は Drive にしか置かないので、この実装は本番の設定では選べない
 * （DRIVE_STORAGE=local を明示したときだけ）。リンクは同じサーバの
 * /api/v3/local-files/<id> への相対パスにしておく。ホスト名を持たないので、
 * 予備系の PC の名前や IP が変わってもリンクが切れない。
 *
 * ファイル名は id そのもの。id は英数と - . _ だけに絞り、パスの外へ出る
 * 文字列（../ など）を id として受け付けない。
 */
export const LOCAL_FILE_LINK_BASE = "/api/v3/local-files";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

interface Meta { filename: string; mimeType: string; documentId?: number }

export class LocalFileStorage implements DriveStorage {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private pathOf(id: string) {
    if (!ID_PATTERN.test(id)) throw new DomainError("VALIDATION", `ファイルIDが不正です: ${id}`);
    return path.join(this.dir, id);
  }

  private readMeta(id: string): Meta | null {
    const file = `${this.pathOf(id)}.json`;
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Meta;
  }

  private write(id: string, data: Buffer, meta: Meta): StoredDriveFile {
    const file = this.pathOf(id);
    fs.writeFileSync(file, data);
    fs.writeFileSync(`${file}.json`, JSON.stringify(meta));
    return { id, webViewLink: `${LOCAL_FILE_LINK_BASE}/${id}` };
  }

  async findByDocumentId(documentId: number): Promise<StoredDriveFile | null> {
    const id = `doc-${documentId}`;
    return fs.existsSync(this.pathOf(id)) ? { id, webViewLink: `${LOCAL_FILE_LINK_BASE}/${id}` } : null;
  }

  async uploadPdf(input: { documentId: number; filename: string; pdf: Buffer }) {
    return this.write(`doc-${input.documentId}`, input.pdf,
      { filename: input.filename, mimeType: "application/pdf", documentId: input.documentId });
  }

  async updatePdf(input: { fileId: string; pdf: Buffer }) {
    const meta = this.readMeta(input.fileId);
    if (!meta) throw new DomainError("NOT_FOUND", `ローカル保存にファイルがありません: ${input.fileId}`);
    return this.write(input.fileId, input.pdf, meta);
  }

  async uploadFile(input: { filename: string; mimeType: string; data: Buffer }) {
    const id = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return this.write(id, input.data, { filename: input.filename, mimeType: input.mimeType });
  }

  async downloadFile(fileId: string) {
    const meta = this.readMeta(fileId);
    const file = this.pathOf(fileId);
    if (!meta || !fs.existsSync(file)) {
      throw new DomainError("NOT_FOUND", `ローカル保存にファイルがありません: ${fileId}`);
    }
    return { data: fs.readFileSync(file), mimeType: meta.mimeType, filename: meta.filename };
  }
}

/** /api/v3/local-files/<id> の形のリンクから id を取り出す。Drive のリンクなら null。 */
export function localFileIdFromLink(link: string | null | undefined): string | null {
  const m = String(link ?? "").match(/\/local-files\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})(?:[?#]|$)/);
  return m ? m[1] : null;
}
