import { DomainError } from "../core/errors.js";
import { KIND_LABEL, type AgreementDomain, type AgreementKind } from "./service.js";
import { DOMAIN_LABEL, type RemapInput } from "./party-map.js";

/**
 * 基本契約の CSV 一括修正。
 *
 * 「取引先⇔基本契約」の画面から全件を書き出し、表計算で直して、運用 → 取込
 * （基本契約・既存の更新）で戻す。当て方は画面の編集と同じ（PartyAgreementMapService.remap）。
 *
 * 当てる先は 契約ID（無ければ 契約番号）。空欄の列は触らない。
 * 消したいときは「なし」と書く（親契約・締結日・有効開始日・終了日・相手方番号）。
 * 取引先・状態・既定・ずれ は参考の列で、取り込んでも変わらない。
 */

export const AGREEMENT_CSV_HEADERS = [
  "契約ID", "契約番号", "取引先", "取引先コード", "件名", "種類", "種別", "方向", "親契約番号",
  "締結日", "有効開始日", "終了日", "自動更新", "相手方番号", "状態", "既定", "ずれ"
] as const;

/** 取り込むときに当てる列。ここに無い列は参考。 */
export const AGREEMENT_CSV_UPDATE_COLUMNS = [
  "件名", "種類", "種別", "方向", "親契約番号", "締結日", "有効開始日", "終了日", "自動更新", "相手方番号"
];

export const AGREEMENT_CSV_REFERENCE_COLUMNS = ["取引先", "取引先コード", "状態", "既定", "ずれ"];

const KIND_BY_TEXT: Record<string, AgreementKind> = {
  ...Object.fromEntries(Object.entries(KIND_LABEL).map(([k, v]) => [v, k as AgreementKind])),
  master: "master", standalone: "standalone", supplement: "supplement",
  termination: "termination", document: "document",
  // 画面ごとに呼び方が違っていた名前も読む。
  付帯文書: "supplement", 補助文書: "supplement", 個別契約: "supplement", 覚書: "supplement", "覚書・変更": "supplement",
  単発の契約: "standalone", 文書: "document", 文書のみ: "document"
};

const DOMAIN_BY_TEXT: Record<string, AgreementDomain | null> = {
  業務委託: "service", service: "service", ライセンス: "license", license: "license",
  未設定: null, なし: null
};

const DIRECTION_BY_TEXT: Record<string, "in" | "out"> = {
  in: "in", IN: "in", In: "in", 取得: "in", out: "out", OUT: "out", Out: "out", 許諾: "out", 委託: "out"
};

const AUTO_RENEW: Record<string, boolean> = {
  する: true, あり: true, 有: true, true: true, yes: true, "1": true,
  しない: false, なし: false, 無: false, false: false, no: false, "0": false
};

const CLEAR = new Set(["なし", "無し", "-", "－"]);

export const STATUS_LABEL: Record<string, string> = {
  draft: "下書き", negotiating: "交渉中", executed: "締結済み", expired: "満了", terminated: "解除"
};

function csvDate(header: string, value: string): string | null {
  if (CLEAR.has(value)) return null;
  const m = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) throw new DomainError("VALIDATION", `${header}は 2026-10-01 か 2026/10/01 の形で入れてください（"${value}"）`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * CSV の1行から、当てる値を読む。親契約は番号で書くので、番号から ID を引く関数を渡す。
 * 読めない値はその場で断る（黙って読み飛ばすと、直したつもりの行が直らない）。
 */
export async function agreementCsvPatch(
  row: Record<string, string>,
  findParent: (agreementNo: string) => Promise<number>
): Promise<RemapInput> {
  const text = (header: string) => String(row[header] ?? "").trim();
  const patch: RemapInput = {};

  const title = text("件名");
  if (title) patch.title = title;

  const kind = text("種類");
  if (kind) {
    const k = KIND_BY_TEXT[kind];
    if (!k) throw new DomainError("VALIDATION",
      `種類は ${Object.values(KIND_LABEL).join("・")} のいずれかです（"${kind}"）`);
    patch.kind = k;
  }
  const domain = text("種別");
  if (domain) {
    if (!(domain in DOMAIN_BY_TEXT)) throw new DomainError("VALIDATION",
      `種別は 業務委託・ライセンス・未設定 のいずれかです（"${domain}"）`);
    patch.domain = DOMAIN_BY_TEXT[domain];
  }
  const direction = text("方向");
  if (direction) {
    const d = DIRECTION_BY_TEXT[direction];
    if (!d) throw new DomainError("VALIDATION", `方向は IN・OUT のいずれかです（"${direction}"）`);
    patch.direction = d;
  }
  const parent = text("親契約番号");
  if (parent) patch.parentId = CLEAR.has(parent) ? null : await findParent(parent);

  const executedOn = text("締結日");
  if (executedOn) patch.executedOn = csvDate("締結日", executedOn);
  const effectiveOn = text("有効開始日");
  if (effectiveOn) patch.effectiveOn = csvDate("有効開始日", effectiveOn);
  const expiresOn = text("終了日");
  if (expiresOn) patch.expiresOn = csvDate("終了日", expiresOn);

  const auto = text("自動更新");
  if (auto) {
    if (!(auto in AUTO_RENEW)) throw new DomainError("VALIDATION", `自動更新は する・しない のいずれかです（"${auto}"）`);
    patch.autoRenewal = AUTO_RENEW[auto];
  }
  const ref = text("相手方番号");
  if (ref) patch.counterpartyRefNo = CLEAR.has(ref) ? null : ref;
  return patch;
}

/** 書き出しの1行。 */
export interface AgreementCsvRow {
  id: number; agreementNo: string | null; partyName: string; partyCode: string | null;
  title: string; kind: AgreementKind; domain: AgreementDomain | null; direction: "in" | "out";
  parentNo: string | null; executedOn: string | null; effectiveOn: string | null; expiresOn: string | null;
  autoRenewal: boolean; counterpartyRefNo: string | null; status: string;
  primary: boolean; issues: string[];
}

export function agreementCsvValues(r: AgreementCsvRow): Record<(typeof AGREEMENT_CSV_HEADERS)[number], string> {
  return {
    契約ID: String(r.id), 契約番号: r.agreementNo ?? "", 取引先: r.partyName, 取引先コード: r.partyCode ?? "",
    件名: r.title, 種類: KIND_LABEL[r.kind], 種別: r.domain ? DOMAIN_LABEL[r.domain] : "",
    方向: r.direction === "in" ? "IN" : "OUT", 親契約番号: r.parentNo ?? "",
    締結日: r.executedOn ?? "", 有効開始日: r.effectiveOn ?? "", 終了日: r.expiresOn ?? "",
    自動更新: r.autoRenewal ? "する" : "しない", 相手方番号: r.counterpartyRefNo ?? "",
    状態: STATUS_LABEL[r.status] ?? r.status, 既定: r.primary ? "既定" : "", ずれ: r.issues.join(" / ")
  };
}
