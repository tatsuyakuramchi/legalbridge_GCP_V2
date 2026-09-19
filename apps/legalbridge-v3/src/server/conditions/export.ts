import { dateStr, int, str, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { USAGE_NAME_LABEL } from "./naming.js";
import type { ConditionUsageType } from "../core/condition-usage.js";

/**
 * 利用許諾条件の書き出し（CSV）。
 *
 * 一括修正（CSV の「登録済みに当てる」）は、条件番号か 作品＋取引モデル で
 * 当てる。どちらにしても、今なにが入っているかを手元に出せないと直しようが
 * ない。170 本を画面で1本ずつ開いて写すのは現実的ではない。
 *
 * 見出しは取込の CSV と同じにする。書き出して、直して、そのまま取り込める
 * （往復できる）ようにするため。取込が当てる先を決めるのは 条件番号 →
 * 作品＋取引モデル の順なので、条件番号を先頭に置く。
 */

/** 取込（license_conditions）と同じ見出し。並びも合わせる。 */
export const CONDITION_EXPORT_HEADERS = [
  "条件番号", "作品コード", "作品名", "許諾者コード", "許諾者", "契約番号",
  "取引モデル", "料率", "独占", "MG", "AG", "開始日", "終了日", "通貨",
  "支払条件", "地域", "言語", "備考", "状態"
] as const;

export interface ConditionExportQuery {
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
        `SELECT c.condition_no, c.usage_type, c.rate_ppm, c.exclusivity, c.mg_amount, c.ag_amount,
                c.term_start, c.term_end, c.currency, c.payment_terms, c.notes, c.status,
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
          -- 直す人が読む順。作品ごとに紙・電子が並ぶ。
          ORDER BY w.title NULLS LAST, c.usage_type NULLS LAST, c.condition_no
          LIMIT $${params.length}`,
        params);

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
        dateStr(x.term_start) ?? "",
        dateStr(x.term_end) ?? "",
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
