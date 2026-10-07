import { dateStr, int, str, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { USAGE_NAME_LABEL } from "./naming.js";
import type { ConditionUsageType } from "../core/condition-usage.js";

/** 許諾料の扱い（A-048）の CSV 表記。取込（imports/service.ts の FEE_BASIS）と対。 */
const LICENSE_FEE_BASIS_CSV: Record<string, string> = {
  separate: "", included: "業務委託報酬に含む", free: "無償"
};

/**
 * 条件の書き出し（CSV）。
 *
 * 一括修正（CSV の「登録済みに当てる」）は、今なにが入っているかを手元に
 * 出せないと直しようがない。170 本を画面で1本ずつ開いて写すのは現実的ではない。
 *
 * 見出しは取込の CSV と同じにする。書き出して、直して、そのまま取り込める
 * （往復できる）ようにするため。
 *
 * 種類で列を分ける。許諾（kind = license）は 作品・取引モデル・料率・独占・
 * 地域… を持ち、業務委託など（委託料・製品・実費・手数料）は 金額・単価×数量・
 * 納期・仕様・契約形式・税区分 を持つ。1つの表に混ぜると、どちらの行も半分が
 * 空欄になって「何が入っているのか」が読めない（ブエノデザイン宛ての委託料が
 * 許諾の列で出て、作品も料率も空、という形になった）。
 */

/**
 * 書き出す種類の群。
 *   license … 利用許諾条件（取込 license_conditions と往復）
 *   service … 業務委託などの条件（取込 service_conditions と往復）。
 *             許諾以外の種類（委託料・製品・実費・手数料）をまとめて出す。
 */
export type ConditionExportGroup = "license" | "service";

/** 取込（license_conditions）と同じ見出し。並びも合わせる。 */
export const CONDITION_EXPORT_HEADERS = [
  "条件番号", "作品コード", "作品名", "許諾者コード", "許諾者", "契約番号",
  "取引モデル", "料率", "独占", "MG", "AG", "別途合意", "許諾料の扱い", "開始日", "終了日",
  "自動更新", "更新の単位", "更新停止日", "通貨",
  "支払条件", "地域", "言語", "備考", "状態"
] as const;

/**
 * 業務委託などの条件の見出し。取込（service_conditions）と同じ。
 * 当てる先は条件番号だけ（作品＋取引モデルのような自然な鍵が無い）。
 * 種類・計算方式・通貨・相手先・契約は読むだけで、取込では当てない
 * （種類と計算方式は「直接編集」のときだけ替えられる。条件の画面で）。
 * 金額・単価は画面と同じく最小通貨単位（JPY なら円）。
 */
export const SERVICE_CONDITION_EXPORT_HEADERS = [
  "条件番号", "種類", "相手先コード", "相手先", "契約番号", "条件名",
  "計算方式", "金額", "単価", "数量", "単位", "通貨",
  "開始日", "終了日", "納期", "支払条件", "契約形式", "税区分", "成果物の帰属", "発注番号",
  "仕様・成果物", "備考", "状態"
] as const;

/** 条件の種類の CSV 表記。画面（client/labels.tsx の CONDITION_KIND_LABEL）と同じ言い方。 */
export const CONDITION_KIND_CSV: Record<string, string> = {
  license: "許諾料", product: "製品", service: "委託料", expense: "実費", fee: "手数料"
};
/** 計算方式の CSV 表記。画面の PRICING_MODEL_LABEL と同じ。 */
export const PRICING_MODEL_CSV: Record<string, string> = {
  fixed: "定額", unit_rate: "単価×数量", revenue_rate: "料率", subscription: "定期課金", none: "計算しない"
};
/** 税区分の CSV 表記。取込はこの語（と英語の値）で受ける。 */
export const TAX_CATEGORY_CSV: Record<string, string> = {
  taxable: "課税", reduced: "軽減", exempt: "非課税", included: "税込"
};
/** 成果物の帰属の CSV 表記。 */
export const DELIVERABLE_OWNERSHIP_CSV: Record<string, string> = {
  orderer: "発注者", contractor: "受注者"
};

export interface ConditionExportQuery {
  /** どの種類の群を、その群の列で出すか。省略は license。 */
  group?: ConditionExportGroup;
  keyword?: string;
  direction?: "in" | "out";
  kind?: string;
  workId?: number;
  matterId?: number;
  includeVoid?: boolean;
  limit?: number;
}

/** 1つの値を CSV の1セルに。区切り・引用符・改行を含むものだけ囲む。 */
export const csvCell = (value: unknown): string => {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (headers: readonly string[], rows: Array<Array<unknown>>): string =>
  [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");

/** 料率。ppm で持っているので % に戻す（取込も % で受ける）。 */
const ratePct = (ppm: unknown): string => {
  const n = int(ppm);
  return n == null ? "" : String(+(n / 10000).toFixed(4));
};

export class ConditionExportService {
  constructor(private readonly database: Transactable) {}

  async run(query: ConditionExportQuery = {}): Promise<string> {
    // 直すために書き出すので、既定では直せない版（無効・旧版）を出さない。
    // 旧版を混ぜると、書き出したものをそのまま取り込んだときに「旧版です」で
    // 止まる行ができる。「無効化済みも」を付けたときだけ全部出す（状態の列で分かる）。
    const where: string[] = query.includeVoid ? ["true"] : ["c.status NOT IN ('void', 'superseded')"];
    // 種類の群で列が違うので、群の外の行は出さない（出すと半分空の行になる）。
    const group: ConditionExportGroup = query.group ?? "license";
    where.push(group === "license" ? "c.kind = 'license'" : "c.kind <> 'license'");
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value); where.push(clause.replace("$?", `$${params.length}`));
    };
    if (query.keyword?.trim()) {
      params.push(`%${query.keyword.trim()}%`);
      const i = params.length;
      where.push(`(c.name ILIKE $${i} OR COALESCE(c.condition_no,'') ILIKE $${i}
                   OR COALESCE(p.name,'') ILIKE $${i} OR COALESCE(w.title,'') ILIKE $${i})`);
    }
    if (query.direction) add("c.direction = $?", query.direction);
    if (query.kind) add("c.kind = $?", query.kind);
    if (query.workId) add("c.work_id = $?", query.workId);
    if (query.matterId) {
      params.push(query.matterId);
      where.push(`EXISTS (SELECT 1 FROM matter_links ml
                           WHERE ml.matter_id = $${params.length}
                             AND ml.target_type = 'condition'
                             AND ml.target_ref = c.id::text)`);
    }
    params.push(Math.min(Math.max(query.limit ?? 1000, 1), 5000));

    try {
      const r = await this.database.query(
        `SELECT c.condition_no, c.kind, c.name, c.usage_type, c.rate_ppm, c.exclusivity, c.mg_amount, c.ag_amount,
                c.sublicense_consent, c.license_fee_basis, c.term_start, c.term_end,
                c.auto_renew, c.renew_months, c.renew_stopped_on, c.currency, c.payment_terms, c.notes, c.status,
                c.pricing_model, c.flat_amount, c.unit_amount, c.quantity, c.unit_label, c.delivery_due,
                c.contract_form, c.tax_category, c.deliverable_ownership, c.order_no, c.spec,
                w.work_code, w.title AS work_title,
                p.party_code, p.name AS party_name,
                ag.agreement_no,
                -- condition_scopes に id は無い（condition_id・scope_type・label が鍵）。
                (SELECT string_agg(s.label, '／' ORDER BY s.sort_order, s.label)
                   FROM condition_scopes s WHERE s.condition_id = c.id AND s.scope_type = 'region') AS regions,
                (SELECT string_agg(s.label, '／' ORDER BY s.sort_order, s.label)
                   FROM condition_scopes s WHERE s.condition_id = c.id AND s.scope_type = 'language') AS languages
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works   w ON w.id = c.work_id
           LEFT JOIN agreements ag ON ag.id = c.agreement_id
          WHERE ${where.join(" AND ")}
          -- 直す人が読む順。許諾は作品ごとに紙・電子が並ぶ。業務委託などは相手先ごと。
          ORDER BY ${group === "license" ? "w.title NULLS LAST, c.usage_type NULLS LAST" : "p.name NULLS LAST"}, c.condition_no
          LIMIT $${params.length}`,
        params);

      if (group === "service") {
        const rows = (r.rows as Array<Record<string, any>>).map((x) => [
          str(x.condition_no) ?? "",
          CONDITION_KIND_CSV[String(x.kind ?? "")] ?? String(x.kind ?? ""),
          str(x.party_code) ?? "",
          str(x.party_name) ?? "",
          str(x.agreement_no) ?? "",
          str(x.name) ?? "",
          PRICING_MODEL_CSV[String(x.pricing_model ?? "")] ?? String(x.pricing_model ?? ""),
          // 金額・単価は最小通貨単位のまま（画面の入力欄と同じ。MG・AG と同じ扱い）。
          int(x.flat_amount) ?? "",
          int(x.unit_amount) ?? "",
          int(x.quantity) ?? "",
          str(x.unit_label) ?? "",
          str(x.currency) ?? "",
          dateStr(x.term_start) ?? "",
          dateStr(x.term_end) ?? "",
          dateStr(x.delivery_due) ?? "",
          str(x.payment_terms) ?? "",
          str(x.contract_form) ?? "",
          TAX_CATEGORY_CSV[String(x.tax_category ?? "")] ?? String(x.tax_category ?? ""),
          DELIVERABLE_OWNERSHIP_CSV[String(x.deliverable_ownership ?? "")] ?? "",
          str(x.order_no) ?? "",
          str(x.spec) ?? "",
          str(x.notes) ?? "",
          String(x.status ?? "")
        ]);
        return toCsv(SERVICE_CONDITION_EXPORT_HEADERS, rows);
      }

      const rows = (r.rows as Array<Record<string, any>>).map((x) => [
        str(x.condition_no) ?? "",
        str(x.work_code) ?? "",
        str(x.work_title) ?? "",
        str(x.party_code) ?? "",
        str(x.party_name) ?? "",
        str(x.agreement_no) ?? "",
        USAGE_NAME_LABEL[x.usage_type as ConditionUsageType] ?? "",
        ratePct(x.rate_ppm),
        x.exclusivity === "exclusive" ? "独占" : x.exclusivity === "non_exclusive" ? "非独占" : "",
        int(x.mg_amount) ?? "",
        int(x.ag_amount) ?? "",
        // 別途合意（A-033）。翻訳版再許諾だけが持つ。それ以外は空。
        x.sublicense_consent === "required" ? "要" : x.sublicense_consent === "covered" ? "不要" : "",
        // 許諾料の扱い（A-048）。別途は空で書く（取込で空＝別途）。
        LICENSE_FEE_BASIS_CSV[String(x.license_fee_basis ?? "")] ?? "",
        dateStr(x.term_start) ?? "",
        dateStr(x.term_end) ?? "",
        // 自動更新（A-039）。更新した回数は書き出さない（数えるもの）。
        x.auto_renew === true ? "する" : x.auto_renew === false ? "しない" : "",
        int(x.renew_months) == null ? ""
          : (int(x.renew_months)! % 12 === 0 ? `${int(x.renew_months)! / 12}年` : `${int(x.renew_months)}か月`),
        dateStr(x.renew_stopped_on) ?? "",
        str(x.currency) ?? "",
        str(x.payment_terms) ?? "",
        str(x.regions) ?? "",
        str(x.languages) ?? "",
        str(x.notes) ?? "",
        // 状態は読むだけ（取込では当てない）。旧版・無効を直そうとして止まる前に気づける。
        String(x.status ?? "")
      ]);
      return toCsv(CONDITION_EXPORT_HEADERS, rows);
    } catch (error) { throw translate(error); }
  }
}
