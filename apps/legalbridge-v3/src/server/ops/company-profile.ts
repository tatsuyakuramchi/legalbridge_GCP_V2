/**
 * 自社情報。書類の差込元。
 *
 * V1 は app_settings に COMPANY_* キーで1件ずつ持っていた。V3 は
 * settings['company_profile'] に1件の JSON で持つ（キー名は V1 の
 * CompanyProfile と同じ）。移行は A-009。
 *
 * これまで読む側（context-repository の company()）しか無く、入れる画面も
 * 経路も無かった。移行元の app_settings に入っていなかった電話番号・FAX・
 * 振込先・捺印備考は、V3 では永久に空のまま書類に出ていた。
 *
 * 項目とラベルは V1 の settings-schema.ts に合わせる。書類側の変数名
 * （COMPANY_TEL など）は legacy-variables.ts の別名表と対になっている。
 *
 * この表は設定画面（クライアント）からも読む。ここに zod を持ち込むと
 * 検証だけのために zod がブラウザ側の束に入るので、検証は別ファイルに置く。
 */

export type CompanyProfileField =
  | "name" | "nameKana" | "postalCode" | "address" | "tel"
  | "fax" | "rep" | "invoiceNo" | "bankInfo" | "sealNote";

export interface CompanyProfileFieldSpec {
  name: CompanyProfileField;
  label: string;
  placeholder?: string;
  /** 1行に収まらないもの。フォームでは横幅いっぱいの複数行にする。 */
  long?: boolean;
}

export const COMPANY_PROFILE_FIELDS: CompanyProfileFieldSpec[] = [
  { name: "name", label: "会社名", placeholder: "株式会社アークライト" },
  { name: "nameKana", label: "会社名（カナ）" },
  { name: "postalCode", label: "郵便番号", placeholder: "101-0052" },
  { name: "address", label: "住所" },
  { name: "tel", label: "電話番号" },
  { name: "fax", label: "FAX" },
  { name: "rep", label: "代表者" },
  { name: "invoiceNo", label: "適格請求書発行事業者番号（T番号）",
    placeholder: "T1234567890123" },
  { name: "bankInfo", label: "自社の振込先（銀行・支店・口座）", long: true },
  { name: "sealNote", label: "捺印・備考", long: true }
];

export type CompanyProfile = Record<CompanyProfileField, string>;

/**
 * 書類に必ず載る項目。空のまま発行すると、相手に渡る紙が欠ける。
 * FAX・カナ・捺印備考はひな形によっては使わないので、ここには入れない。
 */
export const COMPANY_PROFILE_REQUIRED: CompanyProfileField[] = ["name", "address", "rep"];
