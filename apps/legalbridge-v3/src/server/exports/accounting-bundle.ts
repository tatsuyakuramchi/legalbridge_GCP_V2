import { buildZip, type ZipEntry } from "../core/zip.js";
import {
  ACCOUNTING_CATEGORIES, ACCOUNTING_ENTITIES, V1_ACCOUNTING_HEADERS,
  sheetRows, v1AccountingCells, v1FileStem, v1SheetName,
  type AccountingRow
} from "./accounting.js";
import { buildXlsx } from "./xlsx.js";

/**
 * 選んだ支払を、経理へ渡す形（V1 形式の xlsx ＋ 各書類の PDF）の zip にする。
 *
 * searchAPI の「支払Excel発行」（/payments/excel-export）が使う。V3 の画面の
 * 「利用許諾料計算書_個人（PDF 付き zip）」と同じ中身にするため、行は
 * buildAccountingRow の結果（AccountingRow）をそのまま使い、列も同じ関数で組む。
 *
 * xlsx は 種別 × 個人／法人 × 支払日 ごとに 1 ファイル（V1 と同じ分け方）。
 */
export interface BundleDeps {
  /** 決定した書類の PDF。作れなければ投げる（その書類は「PDF未生成.txt」に並べる）。 */
  pdf: (documentId: number) => Promise<Uint8Array>;
}

export interface AccountingBundle {
  name: string;
  data: Uint8Array;
  files: string[];
  /** PDF を同梱できなかった支払（理由付き）。 */
  missing: string[];
}

export async function buildAccountingBundle(
  rows: AccountingRow[], deps: BundleDeps,
  options: { withPdf?: boolean; stem?: string } = {}
): Promise<AccountingBundle> {
  const entries: ZipEntry[] = [];
  const files: string[] = [];

  // 種別 × 個人／法人 × 支払日。並びは V1 と同じ（種別 → 個人／法人 → 日付）。
  const keyOf = (r: AccountingRow) => `${r.category}\u0001${r.entity}\u0001${r.paymentDate}`;
  const groups = new Map<string, AccountingRow[]>();
  for (const row of rows) {
    const list = groups.get(keyOf(row)) ?? [];
    list.push(row);
    groups.set(keyOf(row), list);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const x = a[0]!, y = b[0]!;
    return ACCOUNTING_CATEGORIES.indexOf(x.category) - ACCOUNTING_CATEGORIES.indexOf(y.category)
      || ACCOUNTING_ENTITIES.indexOf(x.entity) - ACCOUNTING_ENTITIES.indexOf(y.entity)
      || (x.paymentDate || "9999").localeCompare(y.paymentDate || "9999");
  });
  for (const list of ordered) {
    const head = list[0]!;
    const name = `${v1FileStem(head.category, head.entity, head.paymentDate)}.xlsx`;
    entries.push({
      name,
      data: buildXlsx([{
        name: v1SheetName(head.category, head.entity),
        rows: [V1_ACCOUNTING_HEADERS, ...sheetRows(list).map(v1AccountingCells)]
      }])
    });
    files.push(name);
  }

  const missing: string[] = [];
  if (options.withPdf !== false) {
    const seen = new Set<number>();
    for (const row of rows) {
      const label = row.documentNo ?? row.paymentNo ?? `支払${row.paymentId}`;
      if (!row.documentId) { missing.push(`${label}（元になった書類がありません）`); continue; }
      if (seen.has(row.documentId)) continue;
      seen.add(row.documentId);
      try {
        const name = `${row.documentNo ?? `document-${row.documentId}`}.pdf`;
        entries.push({ name, data: await deps.pdf(row.documentId) });
        files.push(name);
      } catch {
        missing.push(`${label}（PDF を作れませんでした）`);
      }
    }
    if (missing.length) {
      entries.push({
        name: "PDF未生成.txt",
        data: Buffer.from(`PDF を同梱できなかった支払：\r\n${missing.join("\r\n")}\r\n`, "utf8")
      });
    }
  }

  const dates = rows.map((r) => r.paymentDate).filter(Boolean).sort();
  const stem = options.stem
    ?? `支払申請_${dates[0] ?? "期日未設定"}${dates.length && dates.at(-1) !== dates[0] ? `_${dates.at(-1)}` : ""}`;
  return { name: `${stem}.zip`, data: buildZip(entries), files, missing };
}
