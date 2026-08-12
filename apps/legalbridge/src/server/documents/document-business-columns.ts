import type { PoolClient } from "pg";

// V2 作成文書にも V1 同等の業務列（record_type / contract_status / contract_title / vendor_id）を
// 刻むための導出ロジック（監査 P0-3/P0-4）。V1 は 0101 で contract_capabilities を documents に
// 統合しており、業務列が空だと ①契約状態機械（CloudSign executed 遷移・満了ジョブ）が発火しない
// ②V1 の tg_doc_autolink_contract トリガが空の contracts 行を捏造する。

// form_data 中の相手先名・表題の候補キー（registry/lookup と同じ語彙）。
// PARTY_A_NAME は末尾：NDA では甲＝取引先だが、発注書系では発注元（自社）のため、
// VENDOR_NAME 等の明示キーが存在する場合はそちらが先に採用される（順序が安全性を担保）。
export const PARTY_NAME_KEYS = [
  "VENDOR_NAME", "Licensor_氏名会社名", "Licensor_名称", "許諾者", "相手先", "取引先", "counterparty",
  "PARTY_A_NAME"
];
export const TITLE_KEYS = [
  "PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title", "contractTitle"
];

export function firstTextValue(
  formData: Record<string, unknown> | null | undefined,
  keys: string[]
): string | null {
  if (!formData) return null;
  for (const key of keys) {
    const value = formData[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// V1 の record_type 判定（services/worker/server.ts:9676 の分岐に準拠）。
//   pub_master_* → master_contract ／ pub_* → publication_condition（license を含む語より優先）
//   license/royalty → license_condition ／ purchase_order/inspection → individual_contract
//   それ以外 → master_contract（V1 既定）
export function deriveRecordType(templateType: string): string {
  const t = String(templateType ?? "");
  if (t.startsWith("pub_")) {
    return t.startsWith("pub_master_") ? "master_contract" : "publication_condition";
  }
  if (t.includes("license") || t.includes("royalty")) return "license_condition";
  if (t.includes("purchase_order") || t.includes("inspection")) return "individual_contract";
  // 支払通知書・請求書は取引個別文書として扱う（V1既存の record_type 値のみ使用）。
  if (t.includes("payment") || t.includes("invoice")) return "individual_contract";
  return "master_contract";
}

// 相手先名から vendors.id を解決（V1 と同じ vendor_name → trade_name/pen_name の順）。
// 解決できなくても文書作成は止めない（NULL のまま）。
export async function resolveVendorIdByName(
  client: PoolClient,
  name: string | null
): Promise<number | null> {
  if (!name) return null;
  const result = await client.query(
    `SELECT id FROM vendors
      WHERE vendor_name = $1 OR trade_name = $1 OR pen_name = $1
      ORDER BY (vendor_name = $1) DESC
      LIMIT 1`,
    [name]
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}
