import { exportCsv, exportExcel, type ExportColumn } from "./export-util";

// 一覧の CSV / 軽量Excel 出力ボタン（Phase 6）。依存ゼロ・クライアント完結。
export function ExportButtons<T>({ filename, sheetName, columns, rows }: {
  filename: string;
  sheetName: string;
  columns: ExportColumn<T>[];
  rows: T[];
}) {
  const disabled = !rows.length;
  return (
    <div className="export-buttons">
      <button onClick={() => exportCsv(filename, columns, rows)} disabled={disabled}>CSV出力</button>
      <button onClick={() => exportExcel(filename, sheetName, columns, rows)} disabled={disabled}>Excel出力</button>
    </div>
  );
}
