import type { AppSettingsRepository } from "./settings-repository.js";

// 会社プロファイルの読取（Phase 11-1 の帳票差込配線＝runbook 1-6）。
// 11-1 で app_settings（COMPANY_* キー・grant 036）を編集できるようにしたので、
// 文書作成の自社差込（MasterDataPicker）と intake ブリッジのハードコードを設定値に置き換える。
// 設定が未整備（表なし 42P01／SELECT 権限なし 42501／未入力）のキーは従来のハードコード値へ縮退＝
// 挙動を壊さない。

export interface CompanyProfile {
  name: string;
  nameKana: string;
  postalCode: string;
  address: string;
  tel: string;
  fax: string;
  rep: string;
  invoiceNo: string;
  bankInfo: string;
  sealNote: string;
}

// 従来ハードコードされていた値（master-data/repository.ts 旧 companyProfile()）を既定に据える。
export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  name: "株式会社アークライト",
  nameKana: "",
  postalCode: "",
  address: "東京都千代田区神田小川町1-2 風雲堂ビル2階",
  tel: "",
  fax: "",
  rep: "代表取締役　青柳 昌行",
  invoiceNo: "",
  bankInfo: "",
  sealNote: ""
};

// settings-schema.ts の COMPANY_PROFILE_FIELDS と同じキー（V1 sharedReads と互換）。
const KEY_MAP: Array<[keyof CompanyProfile, string]> = [
  ["name", "COMPANY_NAME"],
  ["nameKana", "COMPANY_NAME_KANA"],
  ["postalCode", "COMPANY_POSTAL_CODE"],
  ["address", "COMPANY_ADDRESS"],
  ["tel", "COMPANY_TEL"],
  ["fax", "COMPANY_FAX"],
  ["rep", "COMPANY_REPRESENTATIVE"],
  ["invoiceNo", "COMPANY_INVOICE_NO"],
  ["bankInfo", "COMPANY_BANK_INFO"],
  ["sealNote", "COMPANY_SEAL_NOTE"]
];

export async function loadCompanyProfile(
  settings: AppSettingsRepository | null | undefined
): Promise<CompanyProfile> {
  const profile: CompanyProfile = { ...DEFAULT_COMPANY_PROFILE };
  if (!settings) return profile;
  try {
    const values = await settings.get(KEY_MAP.map(([, key]) => key));
    for (const [field, key] of KEY_MAP) {
      const value = String(values[key] ?? "").trim();
      if (value) profile[field] = value;
    }
  } catch {
    // 権限未整備等は既定へ縮退（帳票差込を止めない）。
  }
  return profile;
}
