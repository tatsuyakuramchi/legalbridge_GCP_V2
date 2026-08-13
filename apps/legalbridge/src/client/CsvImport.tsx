import { useMemo, useState } from "react";
import { useToast } from "./Toast";
import { parseDelimited } from "./csv-parse";

// 汎用CSV取込UI。マスタごとの差分（列マッピング・必須項目・投入先・ラベル）を
// config で受け取り、貼り付け→ヘッダ自動マップ→プレビュー→一括投入→結果表示までを共通化する。
// サーバ側は各 /<master>/import が {rows} を受けて per-row で検証・投入し
// {insertedCount, failedCount, inserted, failed} を返す前提。

export type CsvColumn = {
  field: string;            // サーバに渡すフィールド名
  label: string;            // プレビュー見出し
  headers: string[];        // 受理するヘッダ表記（日本語・英語・別名）
  required?: boolean;       // 全required列が非空の行だけ投入対象
};

export type CsvImportConfig = {
  kicker: string;
  title: string;
  note: string;
  sampleText: string;
  endpoint: string;
  unit: string;             // メッセージ用の名詞（例：取引先／担当者／作品）
  columns: CsvColumn[];
  panelClass?: string;      // 既定は台帳詳細パネル。担当者は matter-detail 系を渡す。
};

type ImportResult = {
  insertedCount: number;
  failedCount: number;
  failed: Array<{ index: number; error: string }>;
};

function buildHeaderMap(columns: CsvColumn[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const column of columns) {
    for (const header of column.headers) {
      map[header] = column.field;
      map[header.toLowerCase()] = column.field;
    }
  }
  return map;
}

// 区切りテキストの解析は csv-parse.ts（区切り自動判定・引用符対応）へ委譲する。
const parseCsv = parseDelimited;

export function CsvImport({ config, onCancel, onDone }: { config: CsvImportConfig; onCancel: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const headerMap = useMemo(() => buildHeaderMap(config.columns), [config.columns]);
  const parsed = parseCsv(text, headerMap);
  const requiredFields = config.columns.filter((column) => column.required);
  const valid = parsed.rows.filter((row) =>
    requiredFields.every((column) => (row[column.field] ?? "").trim().length > 0));
  const previewColumns = config.columns.slice(0, 4);

  async function submit() {
    if (!valid.length) {
      const names = requiredFields.map((column) => column.label).join("・");
      setError(`取込む${config.unit}がありません（${names}の列が必要です）。`); return;
    }
    setSaving(true); setError(""); setResult(null);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: valid })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 422 && response.status !== 201) {
        setError(data.error ?? "取込に失敗しました。"); setSaving(false); return;
      }
      setResult(data);
      toast.push(`${data.insertedCount}件を登録しました${data.failedCount ? `（${data.failedCount}件失敗）` : ""}`,
        data.failedCount ? "info" : "success");
      if (data.insertedCount) onDone();
    } catch {
      setError("通信に失敗しました。");
    } finally { setSaving(false); }
  }

  return <aside className={config.panelClass ?? "panel ledger-detail matter-editor"}>
    <span className="detail-kicker">{config.kicker}</span><h2>{config.title}</h2>
    <p className="hub-note">{config.note}</p>
    <p className="hub-note">Excelからセル範囲をコピーして貼り付け（タブ区切り）や、「CSVとして保存」した引用符付きCSVもそのまま取り込めます。</p>
    {error && <div className="async-error">{error}</div>}
    <textarea rows={8} value={text} onChange={(event) => { setText(event.target.value); setResult(null); }}
      placeholder={config.sampleText} />
    {parsed.rows.length > 0 && <p className="import-preview-note">
      解析 {parsed.rows.length}行 / 登録対象 {valid.length}行
      {parsed.unmapped.length > 0 && `・未対応列: ${parsed.unmapped.join(", ")}`}
    </p>}
    {valid.length > 0 && <div className="condition-table-wrap"><table className="condition-table">
      <thead><tr>{previewColumns.map((column) => <th key={column.field}>{column.label}</th>)}</tr></thead>
      <tbody>{valid.slice(0, 20).map((row, index) => <tr key={index}>
        {previewColumns.map((column, columnIndex) => <td key={column.field}>
          {columnIndex === 0 ? <b>{row[column.field]}</b> : (row[column.field] || "—")}
        </td>)}
      </tr>)}</tbody></table>{valid.length > 20 && <p className="import-preview-note">ほか {valid.length - 20}行…</p>}</div>}
    {result && <div className="import-result">
      <strong>{result.insertedCount}件 登録完了</strong>{result.failedCount > 0 && <span>・{result.failedCount}件 失敗</span>}
      {result.failed.slice(0, 10).map((failure) => <small key={failure.index}>行{failure.index + 2}: {failure.error}</small>)}
    </div>}
    <div className="matter-form-actions">
      <button className="primary" disabled={saving || !valid.length} onClick={submit}>{saving ? "取込中…" : `${valid.length}件を登録`}</button>
      <button disabled={saving} onClick={onCancel}>閉じる</button>
    </div>
  </aside>;
}

// マスタ別の列定義（ヘッダ別名を1か所に集約）。
export const vendorCsvConfig: CsvImportConfig = {
  kicker: "IMPORT VENDORS", title: "取引先CSV取込", unit: "取引先",
  note: "1行目にヘッダ（取引先名 / 取引先コード / 種別 / メール 等）、2行目以降にデータを貼り付けてください。取引先名は必須。カンマ区切り、囲み文字なしの簡易CSVに対応します。",
  sampleText: "取引先名,種別,メール\n株式会社アークライト,法人,info@example.com",
  endpoint: "/api/v2/vendors/import",
  columns: [
    { field: "vendorName", label: "取引先名", required: true, headers: ["取引先名", "vendor_name", "vendorname", "name"] },
    { field: "entityType", label: "種別", headers: ["種別", "entity_type"] },
    { field: "email", label: "メール", headers: ["メール", "email", "メールアドレス"] },
    { field: "vendorCode", label: "コード", headers: ["取引先コード", "vendor_code", "vendorcode", "code"] },
    { field: "tradeName", label: "屋号", headers: ["屋号", "trade_name"] },
    { field: "penName", label: "ペンネーム", headers: ["ペンネーム", "pen_name"] },
    { field: "phone", label: "電話", headers: ["電話", "phone", "電話番号"] },
    { field: "contactName", label: "担当者", headers: ["担当者", "contact_name"] },
    { field: "contactDepartment", label: "担当部署", headers: ["担当部署", "contact_department", "部署"] },
    { field: "address", label: "住所", headers: ["住所", "address"] },
    { field: "invoiceRegistrationNumber", label: "インボイス番号", headers: ["インボイス番号", "invoice_registration_number"] },
    // 法人登録項目・振込先（V1 CSV の日本語見出しに合わせる）。
    // 口座列を含む取込は管理者のみ（サーバが VENDOR_BANK_FORBIDDEN で拒否）。
    { field: "vendorRep", label: "代表者名", headers: ["代表者名", "代表者", "代表", "vendor_rep", "vendorrep"] },
    { field: "corporateNumber", label: "法人番号", headers: ["法人番号", "corporate_number"] },
    { field: "bankName", label: "金融機関名", headers: ["金融機関名", "銀行名", "bank_name", "bankname"] },
    { field: "branchName", label: "支店名", headers: ["支店名", "branch_name", "branchname"] },
    { field: "accountType", label: "口座種別", headers: ["口座種別", "預金種別", "account_type", "accounttype"] },
    { field: "accountNumber", label: "口座番号", headers: ["口座番号", "account_number", "accountnumber"] },
    { field: "accountHolderKana", label: "口座名義カナ", headers: ["口座名義カナ", "名義人カナ", "account_holder_kana", "accountholderkana"] }
  ]
};

export const staffCsvConfig: CsvImportConfig = {
  kicker: "IMPORT STAFF", title: "担当者CSV取込", unit: "担当者",
  panelClass: "panel matter-detail matter-editor",
  note: "1行目にヘッダ（氏名 / Slackユーザーid / 部署 / メール 等）、2行目以降にデータを貼り付けてください。氏名とSlack ユーザーIDは必須。",
  sampleText: "氏名,Slackユーザーid,部署\n田中太郎,U01234567,法務部",
  endpoint: "/api/v2/staff/import",
  columns: [
    { field: "staffName", label: "氏名", required: true, headers: ["氏名", "staff_name", "staffname", "name", "担当者"] },
    { field: "slackUserId", label: "Slack ID", required: true, headers: ["slackユーザーid", "slack_user_id", "slackuserid", "slackid", "slack"] },
    { field: "department", label: "部署", headers: ["部署", "department"] },
    { field: "departmentCode", label: "部署コード", headers: ["部署コード", "department_code"] },
    { field: "email", label: "メール", headers: ["メール", "email"] },
    { field: "phone", label: "電話", headers: ["電話", "phone"] }
  ]
};

export const materialCsvConfig: CsvImportConfig = {
  kicker: "IMPORT MATERIALS", title: "素材CSV取込", unit: "素材",
  note: "1行目にヘッダ、2行目以降にデータ。作品ID・素材名・素材区分・役割・取得区分は必須。素材区分=game_design/illustration/scenario/manuscript/other、役割=core_logic/sub_component、取得区分=license/buyout_commission/in_house、権利区分=owned/license。作品IDは既存作品の数値ID。",
  sampleText: "作品ID,素材名,素材区分,役割,取得区分,ロイヤリティ対象\n123,シナリオ原稿,scenario,core_logic,license,対象",
  endpoint: "/api/v2/materials/import",
  columns: [
    { field: "workId", label: "作品ID", required: true, headers: ["作品id", "work_id", "workid", "作品"] },
    { field: "materialName", label: "素材名", required: true, headers: ["素材名", "material_name", "materialname", "name"] },
    { field: "materialType", label: "素材区分", required: true, headers: ["素材区分", "material_type", "materialtype", "type"] },
    { field: "materialRole", label: "役割", required: true, headers: ["役割", "material_role", "materialrole", "role"] },
    { field: "acquisitionType", label: "取得区分", required: true, headers: ["取得区分", "acquisition_type", "acquisitiontype"] },
    { field: "rightsType", label: "権利区分", headers: ["権利区分", "rights_type", "rightstype"] },
    { field: "rightsHolderVendorId", label: "権利者ID", headers: ["権利者id", "rights_holder_vendor_id"] },
    { field: "rightsHolderLabel", label: "権利者名", headers: ["権利者名", "rights_holder_label"] },
    { field: "territory", label: "地域", headers: ["地域", "territory"] },
    { field: "language", label: "言語", headers: ["言語", "language"] },
    { field: "isRoyaltyBearing", label: "ロイヤリティ対象", headers: ["ロイヤリティ対象", "is_royalty_bearing", "royalty"] },
    { field: "remarks", label: "備考", headers: ["備考", "remarks", "note"] }
  ]
};

export const workCsvConfig: CsvImportConfig = {
  kicker: "IMPORT WORKS", title: "作品CSV取込", unit: "作品",
  note: "1行目にヘッダ（作品名 / 作品コード / 台帳コード / 備考 等）、2行目以降にデータを貼り付けてください。作品名は必須。コードは未入力で自動採番されます。",
  sampleText: "作品名,台帳コード,備考\nサンプル作品,LG-001,テスト",
  endpoint: "/api/v2/works/import",
  columns: [
    { field: "title", label: "作品名", required: true, headers: ["作品名", "title", "name", "作品"] },
    { field: "workCode", label: "作品コード", headers: ["作品コード", "work_code", "workcode", "code"] },
    { field: "ledgerCode", label: "台帳コード", headers: ["台帳コード", "ledger_code", "ledgercode"] },
    { field: "remarks", label: "備考", headers: ["備考", "remarks", "note"] }
  ]
};
