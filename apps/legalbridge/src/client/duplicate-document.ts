import type { DocumentFormData } from "../types";

// 確定済み文書を「同じ内容で相手先だけ違う別文書」として作り直すための下ごしらえ。
//
// 想定する依頼: 「同じ内容の発注書を取引先A・Bの2通ぶん作ってほしい」。
// 1通目を確定したあと、その内容を丸ごと引き継いだ新規入力を開き、相手先だけ
// 差し替えて2通目を確定する。文書番号は確定時に採番されるので、複製の時点では
// 前の文書の番号・宛先・署名の痕跡を必ず落とす（引き継ぐと前の相手先の宛名や
// 口座が残ったまま2通目が出る）。
//
// 明細・金銭条件・特約などの中身はそのまま引き継ぐ（それが複製の目的）。

// 前の文書を指す識別子。残すと2通目が旧番号で表示・renderされる恐れがある。
const IDENTITY_KEYS = [
  "documentNumber", "document_number", "文書番号", "契約書番号", "発注番号",
  "CONTRACT_NO", "DOC_NO", "ORDER_NO",
  "base_document_number", "BASE_DOC_NO", "元契約番号", "元文書番号",
  "REVISION", "改訂番号", "isReissue", "再発行フラグ", "showReissueBanner",
  "superseded_by", "lifecycle_status", "is_primary"
];

// 相手先そのもの。複製の狙いは「ここだけ差し替える」ことなので、
// 前の相手先を残して上書き漏れを招くより、空にして選び直させる。
const COUNTERPARTY_KEYS = [
  "VENDOR_NAME", "取引先名", "vendor_name", "vendorName",
  "VENDOR_ID", "vendor_id", "VENDOR_CODE",
  "VENDOR_ADDRESS", "VENDOR_POSTAL_CODE", "VENDOR_TEL", "VENDOR_EMAIL",
  "VENDOR_REP", "VENDOR_REP_TITLE", "VENDOR_CONTACT_NAME", "VENDOR_CONTACT_DEPARTMENT",
  "VENDOR_IS_CORPORATION", "VENDOR_SUFFIX", "取引先種別", "vendorEntityType",
  "COUNTERPARTY_NAME", "相手方", "相手先名", "COUNTERPARTY_IS_CORPORATION",
  "LICENSOR_NAME", "許諾者名", "許諾者種別", "LICENSOR_SUFFIX", "LICENSOR_IS_CORPORATION",
  // 振込先は取引先に紐づくので必ず選び直す（前の相手先の口座で出すと事故になる）。
  "BANK_NAME", "BRANCH_NAME", "ACCOUNT_TYPE", "ACCOUNT_NUMBER",
  "ACCOUNT_HOLDER", "ACCOUNT_HOLDER_KANA", "BANK_INFO"
];

// 相手先の承諾・署名の記録。前の相手先のものを引き継いではいけない。
const ACCEPTANCE_KEYS = [
  "VENDOR_ACCEPT_DATE", "VENDOR_ACCEPT_NAME", "ACCEPT_REPLY_DUE_DATE",
  "SIGN_DATE", "契約締結日", "受領日", "承諾日"
];

export const DUPLICATE_CLEARED_KEYS: readonly string[] = [
  ...IDENTITY_KEYS, ...COUNTERPARTY_KEYS, ...ACCEPTANCE_KEYS
];

export interface DuplicateSource {
  templateType: string;
  issueKey: string;
  formData: DocumentFormData;
}

// 複製の初期値。落とすキーは削除する（空文字ではなく未設定にして、
// 相手先ボタンでの自動入力や敬称の導出が新しい相手先で走るようにする）。
export function duplicateFormData(formData: DocumentFormData): DocumentFormData {
  const next: DocumentFormData = {};
  const cleared = new Set(DUPLICATE_CLEARED_KEYS);
  for (const [key, value] of Object.entries(formData ?? {})) {
    if (cleared.has(key)) continue;
    next[key] = value;
  }
  return next;
}

// 何が引き継がれ、何が消えたかを利用者に伝えるための要約（トーストに出す）。
export function describeDuplicate(formData: DocumentFormData): {
  carried: number; cleared: string[];
} {
  const cleared = DUPLICATE_CLEARED_KEYS.filter((key) => {
    const value = (formData ?? {})[key];
    return value !== undefined && value !== null && value !== "";
  });
  return { carried: Object.keys(duplicateFormData(formData)).length, cleared };
}
