import { api, ApiError } from "./api.js";
import { buildZip, safeFileName, type ZipEntry } from "../server/core/zip.js";

/**
 * 取引先を選んで、決定済みの文書の最新版を PDF で ZIP に落とす（画面側で組む）。
 *
 * サーバで ZIP まで作ると、PDF を 1 枚ずつ描く数十秒のあいだ画面は何も
 * 言えない。ここでは一覧を先にもらい、1 枚ずつ PDF を取りながら
 * 「何枚目を作っているか」を知らせる。ZIP は手元で組む（依存なし）。
 *
 * 読めなかった文書は ZIP の中の「読めなかった文書.txt」に理由を残す。
 */
export interface ExportProgress {
  done: number;
  total: number;
  /** いま描いている文書の番号。 */
  current: string | null;
  failed: number;
}

interface ExportList {
  zipName: string;
  documents: Array<{ id: number; documentNo: string; folder: string }>;
}

export async function exportDocumentsZip(
  matterId: number, partyIds: number[], onProgress: (p: ExportProgress) => void
): Promise<{ zipName: string; documents: number; failed: string[] }> {
  const list = await api.get<ExportList>(
    `/matters/${matterId}/export-documents?parties=${partyIds.join(",")}`);
  const total = list.documents.length;
  const entries: ZipEntry[] = [];
  const failed: string[] = [];
  let done = 0;
  onProgress({ done, total, current: list.documents[0]?.documentNo ?? null, failed: 0 });

  for (const doc of list.documents) {
    onProgress({ done, total, current: doc.documentNo, failed: failed.length });
    try {
      const response = await fetch(`/api/v3/documents/${doc.id}/pdf`);
      if (!response.ok) {
        let reason = `HTTP ${response.status}`;
        try { reason = (JSON.parse(await response.text()) as { error?: string }).error ?? reason; } catch { /* 本文なし */ }
        throw new ApiError(response.status, reason);
      }
      const data = new Uint8Array(await response.arrayBuffer());
      entries.push({ name: `${doc.folder}/${safeFileName(`${doc.documentNo}.pdf`)}`, data });
    } catch (e) {
      failed.push(`${doc.documentNo}（${doc.folder}）：${e instanceof Error ? e.message : String(e)}`);
    }
    done += 1;
    onProgress({ done, total, current: doc.documentNo, failed: failed.length });
  }
  if (failed.length) {
    entries.push({ name: "読めなかった文書.txt", data: new TextEncoder().encode(`${failed.join("\n")}\n`) });
  }

  const zip = buildZip(entries);
  // Blob は ArrayBuffer を要る（型の上で SharedArrayBuffer を除くため写す）。
  const bytes = new Uint8Array(new ArrayBuffer(zip.length)); bytes.set(zip);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url; a.download = list.zipName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return { zipName: list.zipName, documents: entries.length - (failed.length ? 1 : 0), failed };
}
