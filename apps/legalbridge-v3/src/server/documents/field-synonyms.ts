/**
 * 文書をまとめて作るときの「同じ意味の欄」。
 *
 * 基本契約書（本番 DB のひな形）と個別利用許諾条件書 V3（コードの項目）は、同じものを
 * 違う名前で持っている（ライセンサー名称＝VENDOR_NAME／Licensor_氏名会社名）。名前だけで
 * 共通の欄を決めると、同じ相手先の担当者を 2 回打つことになる。ここで組にして 1 つの欄にする。
 * 一覧は本番のひな形の項目（license_master・service_master・purchase_order、2026-10 時点）から。
 * 業務委託の基本契約書と発注書は VENDOR_*・PARTY_A_* が同じ名前なので、組にしなくても共通になる。
 */
const GROUPS: Record<string, string[]> = {
  // 相手方（VENDOR）＝ IN のライセンサー（許諾者）／業務委託の乙（受託者）
  vendor_name: ["VENDOR_NAME", "Licensor_氏名会社名"],
  vendor_address: ["VENDOR_ADDRESS", "Licensor_住所"],
  vendor_rep: ["VENDOR_REP", "Licensor_代表者名"],
  // 相手方の担当者：基本契約書は「通知先（相手方・乙）」、条件書は Licensor_担当者、
  // 発注書は「発注先 担当者」（VENDOR_CONTACT_*）。
  vendor_contact: ["NOTICE_CONTACT_NAME", "Licensor_担当者", "VENDOR_CONTACT_NAME"],
  vendor_phone: ["NOTICE_CONTACT_PHONE", "Licensor_電話", "VENDOR_CONTACT_PHONE"],
  vendor_email: ["NOTICE_CONTACT_EMAIL", "Licensor_メール", "VENDOR_CONTACT_EMAIL"],
  // 当社（PARTY_A）＝ IN のライセンシー（被許諾者）／業務委託の甲（委託者）
  party_a_name: ["PARTY_A_NAME", "Licensee_氏名会社名"],
  party_a_address: ["PARTY_A_ADDRESS", "Licensee_住所"],
  party_a_rep: ["PARTY_A_REP", "Licensee_代表者名"]
};

const CANON = new Map<string, string>();
for (const [key, names] of Object.entries(GROUPS)) for (const n of names) CANON.set(n, `~${key}`);

/** 欄の組の名前（組に無ければその欄の名前のまま）。 */
export const canonicalField = (name: string): string => CANON.get(name) ?? name;

/** 組の名前を、その組のすべての欄の名前に開く（文書ごとの手入力に入れる）。 */
export function expandShared(shared: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(shared)) {
    const names = k.startsWith("~") ? GROUPS[k.slice(1)] ?? [] : [k];
    for (const n of names) out[n] = v;
  }
  return out;
}
