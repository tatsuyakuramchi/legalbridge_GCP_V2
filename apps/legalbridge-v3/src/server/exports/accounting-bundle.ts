import { buildZip, type ZipEntry } from "../core/zip.js";
import {
  ACCOUNTING_CATEGORIES, ACCOUNTING_ENTITIES, V1_ACCOUNTING_HEADERS, mergeByPayee,
  sheetRows, v1AccountingCells, v1FileStem, v1SheetName,
  type AccountingRow
} from "./accounting.js";
import { buildXlsx, type XlsxSheet } from "./xlsx.js";

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

/** 種別 × 個人／法人 × 支払日 に分ける。並びは V1 と同じ（種別 → 個人／法人 → 日付）。 */
export function v1Groups(rows: AccountingRow[]): AccountingRow[][] {
  const keyOf = (r: AccountingRow) => `${r.category}\u0001${r.entity}\u0001${r.paymentDate}`;
  const groups = new Map<string, AccountingRow[]>();
  for (const row of rows) {
    const list = groups.get(keyOf(row)) ?? [];
    list.push(row);
    groups.set(keyOf(row), list);
  }
  return [...groups.values()].sort((a, b) => {
    const x = a[0]!, y = b[0]!;
    return ACCOUNTING_CATEGORIES.indexOf(x.category) - ACCOUNTING_CATEGORIES.indexOf(y.category)
      || ACCOUNTING_ENTITIES.indexOf(x.entity) - ACCOUNTING_ENTITIES.indexOf(y.entity)
      || (x.paymentDate || "9999").localeCompare(y.paymentDate || "9999");
  });
}

/**
 * 期間の支払を 1 つの xlsx にまとめる（画面の「全部まとめて」）。
 *
 * 画面の束（支払日 × 社内担当 × 通貨）と V1 のファイル（種別 × 個人／法人 × 支払日）で
 * 二重に分かれ、経理に渡すファイルが何本にもなっていた。中身（52 列・続きの行）は V1 と同じ。
 *   sheets … 種別 × 個人／法人 ごとに 1 シート（支払日が 2 つ以上あればシート名に日付）
 *   one    … 1 シートに全部（種別 → 個人／法人 → 支払日 の順）
 */
export function combinedAccountingSheets(
  rows: AccountingRow[], layout: "sheets" | "one" = "sheets", options: { merge?: boolean } = {}
): XlsxSheet[] {
  const groups = v1Groups(options.merge ? mergeByPayee(rows) : rows);
  if (layout === "one") {
    return [{ name: "経理提出用", rows: [V1_ACCOUNTING_HEADERS, ...groups.flatMap((g) => sheetRows(g).map(v1AccountingCells))] }];
  }
  const datesOf = new Map<string, Set<string>>();
  for (const g of groups) {
    const k = v1SheetName(g[0]!.category, g[0]!.entity);
    datesOf.set(k, (datesOf.get(k) ?? new Set()).add(g[0]!.paymentDate));
  }
  return groups.map((g) => {
    const head = g[0]!;
    const base = v1SheetName(head.category, head.entity);
    const name = (datesOf.get(base)?.size ?? 0) > 1 ? `${base}_${head.paymentDate || "期日未設定"}` : base;
    return { name: name.slice(0, 31), rows: [V1_ACCOUNTING_HEADERS, ...sheetRows(g).map(v1AccountingCells)] };
  });
}

export async function buildAccountingBundle(
  rows: AccountingRow[], deps: BundleDeps,
  options: { withPdf?: boolean; stem?: string; merge?: boolean } = {}
): Promise<AccountingBundle> {
  const entries: ZipEntry[] = [];
  const files: string[] = [];

  // 支払先ごとにまとめるのは xlsx の行だけ。PDF は元の支払（書類）ごとに全部入れる。
  for (const list of v1Groups(options.merge ? mergeByPayee(rows) : rows)) {
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
