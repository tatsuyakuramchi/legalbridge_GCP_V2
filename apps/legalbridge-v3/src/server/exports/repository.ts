import type { Transactable } from "../core/db.js";
import { dateStr } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { majorUnits, percent, toCsv, type Column } from "./csv.js";

/**
 * 一覧の全件出力。
 *
 * 画面の一覧には上限があるので、経理提出や V1 との突き合わせには足りない。
 * ここは上限を付けずに出す（現状の規模は数千件で、絞る必要が無い）。
 *
 * 金額は最小通貨単位で持っているが、CSV では主単位の数値にする。
 * 表計算で合計できないと出力する意味が無いので、通貨記号も桁区切りも付けない。
 */

export type Dataset = "conditions" | "payments" | "documents" | "parties" | "balances" | "statements";

export const DATASETS: Array<{ key: Dataset; label: string }> = [
  { key: "conditions", label: "条件" },
  { key: "balances", label: "条件の消化と残高" },
  { key: "payments", label: "支払" },
  { key: "statements", label: "計算書" },
  { key: "documents", label: "文書" },
  { key: "parties", label: "取引先" }
];

const DIRECTION: Record<string, string> = { in: "IN 取得", out: "OUT 許諾" };

export class ExportRepository {
  constructor(private readonly database: Transactable) {}

  async csv(dataset: Dataset): Promise<{ csv: string; rows: number }> {
    try {
      const built = await this.build(dataset);
      return { csv: toCsv(built.columns as Array<Column<any>>, built.rows), rows: built.rows.length };
    } catch (error) { throw translate(error); }
  }

  private async build(dataset: Dataset): Promise<{ columns: Array<Column<any>>; rows: any[] }> {
    switch (dataset) {
      case "conditions": {
        const r = await this.database.query(
          `SELECT c.condition_no, c.name, c.direction, c.kind, c.status,
                  p.name AS party, p.kind AS party_kind, w.title AS work, wp.name AS part,
                  a.agreement_no, c.currency, c.pricing_model, c.rate_ppm,
                  c.unit_amount, c.flat_amount, c.mg_amount, c.ag_amount,
                  c.term_start, c.term_end, c.tax_category, c.payment_terms, c.cycle,
                  c.exclusivity, c.sublicensable, c.legacy_id
             FROM conditions c
             JOIN parties p ON p.id = c.counterparty_id
             LEFT JOIN works w ON w.id = c.work_id
             LEFT JOIN work_parts wp ON wp.id = c.work_part_id
             LEFT JOIN agreements a ON a.id = c.agreement_id
            ORDER BY c.condition_no NULLS LAST, c.id`);
        return {
          rows: r.rows,
          columns: [
            { header: "条件番号", value: (x: any) => x.condition_no },
            { header: "条件名", value: (x: any) => x.name },
            { header: "向き", value: (x: any) => DIRECTION[x.direction] ?? x.direction },
            { header: "種類", value: (x: any) => x.kind },
            { header: "状態", value: (x: any) => x.status },
            { header: "相手先", value: (x: any) => x.party },
            { header: "相手先区分", value: (x: any) => (x.party_kind === "individual" ? "個人" : "法人") },
            { header: "作品", value: (x: any) => x.work },
            { header: "パート", value: (x: any) => x.part },
            { header: "合意番号", value: (x: any) => x.agreement_no },
            { header: "通貨", value: (x: any) => x.currency },
            { header: "計算方式", value: (x: any) => x.pricing_model },
            { header: "料率(%)", value: (x: any) => percent(x.rate_ppm) },
            { header: "単価", value: (x: any) => majorUnits(x.unit_amount, x.currency) },
            { header: "定額", value: (x: any) => majorUnits(x.flat_amount, x.currency) },
            { header: "MG", value: (x: any) => majorUnits(x.mg_amount, x.currency) },
            { header: "AG", value: (x: any) => majorUnits(x.ag_amount, x.currency) },
            { header: "開始", value: (x: any) => dateStr(x.term_start) },
            { header: "終了", value: (x: any) => dateStr(x.term_end) },
            { header: "税区分", value: (x: any) => x.tax_category },
            { header: "支払条件", value: (x: any) => x.payment_terms },
            { header: "周期", value: (x: any) => x.cycle },
            { header: "独占性", value: (x: any) => x.exclusivity },
            { header: "再許諾可", value: (x: any) => (x.sublicensable === null ? "" : x.sublicensable ? "可" : "不可") },
            { header: "移行元ID", value: (x: any) => x.legacy_id }
          ]
        };
      }

      case "balances": {
        const r = await this.database.query(
          `SELECT b.*, c.name, p.name AS party
             FROM v_condition_balance b
             JOIN conditions c ON c.id = b.condition_id
             JOIN parties p ON p.id = c.counterparty_id
            ORDER BY b.condition_no NULLS LAST, b.condition_id`);
        return {
          rows: r.rows,
          columns: [
            { header: "条件番号", value: (x: any) => x.condition_no },
            { header: "条件名", value: (x: any) => x.name },
            { header: "相手先", value: (x: any) => x.party },
            { header: "向き", value: (x: any) => DIRECTION[x.direction] ?? x.direction },
            { header: "通貨", value: (x: any) => x.currency },
            { header: "MG(下限)", value: (x: any) => majorUnits(x.mg_amount, x.currency) },
            { header: "AG(前払)", value: (x: any) => majorUnits(x.ag_amount, x.currency) },
            { header: "予定合計", value: (x: any) => majorUnits(x.planned_total, x.currency) },
            { header: "実績合計", value: (x: any) => majorUnits(x.consumed_total, x.currency) },
            { header: "AG消化", value: (x: any) => majorUnits(x.ag_consumed, x.currency) },
            { header: "AG残", value: (x: any) => majorUnits(x.ag_remaining, x.currency) }
          ]
        };
      }

      case "payments": {
        const r = await this.database.query(
          `SELECT y.payment_no, y.direction, y.status, y.currency, y.amount,
                  y.tax_amount, y.withholding_amount, y.basis_received_on, y.due_on, y.paid_on,
                  y.note, p.name AS party, p.kind AS party_kind, p.invoice_no,
                  (SELECT string_agg(c.condition_no, ' / ' ORDER BY c.condition_no)
                     FROM payment_allocations al JOIN conditions c ON c.id = al.condition_id
                    WHERE al.payment_id = y.id) AS conditions
             FROM payments y JOIN parties p ON p.id = y.party_id
            ORDER BY y.due_on NULLS LAST, y.id`);
        return {
          rows: r.rows,
          columns: [
            { header: "支払番号", value: (x: any) => x.payment_no },
            { header: "向き", value: (x: any) => (x.direction === "out" ? "支払" : "入金") },
            { header: "状態", value: (x: any) => x.status },
            { header: "相手先", value: (x: any) => x.party },
            { header: "相手先区分", value: (x: any) => (x.party_kind === "individual" ? "個人" : "法人") },
            { header: "インボイス番号", value: (x: any) => x.invoice_no },
            { header: "通貨", value: (x: any) => x.currency },
            { header: "税抜", value: (x: any) => majorUnits(x.amount, x.currency) },
            { header: "消費税", value: (x: any) => majorUnits(x.tax_amount, x.currency) },
            { header: "源泉", value: (x: any) => majorUnits(x.withholding_amount, x.currency) },
            { header: "差引", value: (x: any) =>
                majorUnits(Number(x.amount ?? 0) + Number(x.tax_amount ?? 0) - Number(x.withholding_amount ?? 0), x.currency) },
            { header: "受領日", value: (x: any) => dateStr(x.basis_received_on) },
            { header: "期日", value: (x: any) => dateStr(x.due_on) },
            { header: "支払日", value: (x: any) => dateStr(x.paid_on) },
            { header: "対象条件", value: (x: any) => x.conditions },
            { header: "摘要", value: (x: any) => x.note }
          ]
        };
      }

      case "statements": {
        const r = await this.database.query(
          `SELECT s.id, s.period, s.currency, s.gross_amount, s.mg_topup, s.ag_offset,
                  s.net_amount, s.tax_amount,
                  c.condition_no, c.name, p.name AS party,
                  d.document_no, d.issued_at
             FROM statements s
             JOIN conditions c ON c.id = s.condition_id
             JOIN parties p ON p.id = c.counterparty_id
             JOIN documents d ON d.id = s.document_id
            ORDER BY s.period NULLS LAST, s.id`);
        return {
          rows: r.rows,
          columns: [
            { header: "期間", value: (x: any) => x.period },
            { header: "文書番号", value: (x: any) => x.document_no },
            { header: "条件番号", value: (x: any) => x.condition_no },
            { header: "条件名", value: (x: any) => x.name },
            { header: "相手先", value: (x: any) => x.party },
            { header: "通貨", value: (x: any) => x.currency },
            { header: "算定額", value: (x: any) => majorUnits(x.gross_amount, x.currency) },
            { header: "MG差額", value: (x: any) => majorUnits(x.mg_topup, x.currency) },
            { header: "AG相殺", value: (x: any) => majorUnits(x.ag_offset, x.currency) },
            { header: "正味", value: (x: any) => majorUnits(x.net_amount, x.currency) },
            { header: "消費税", value: (x: any) => majorUnits(x.tax_amount, x.currency) },
            { header: "発行日", value: (x: any) => dateStr(x.issued_at) }
          ]
        };
      }

      case "documents": {
        const r = await this.database.query(
          `SELECT d.document_no, d.status, d.issued_at, d.issued_by, d.storage_url,
                  t.label AS template, m.matter_no, a.agreement_no,
                  prev.document_no AS supersedes,
                  (SELECT count(*) FROM document_conditions x WHERE x.document_id = d.id) AS conditions
             FROM documents d
             LEFT JOIN document_template_versions v ON v.id = d.template_version_id
             LEFT JOIN document_templates t ON t.id = v.template_id
             LEFT JOIN matters m ON m.id = d.matter_id
             LEFT JOIN agreements a ON a.id = d.agreement_id
             LEFT JOIN documents prev ON prev.id = d.supersedes_id
            ORDER BY d.document_no NULLS LAST, d.id`);
        return {
          rows: r.rows,
          columns: [
            { header: "文書番号", value: (x: any) => x.document_no },
            { header: "テンプレート", value: (x: any) => x.template },
            { header: "状態", value: (x: any) => x.status },
            { header: "案件番号", value: (x: any) => x.matter_no },
            { header: "合意番号", value: (x: any) => x.agreement_no },
            { header: "条件数", value: (x: any) => x.conditions },
            { header: "差替元", value: (x: any) => x.supersedes },
            { header: "発行日", value: (x: any) => dateStr(x.issued_at) },
            { header: "発行者", value: (x: any) => x.issued_by },
            { header: "保管先", value: (x: any) => x.storage_url }
          ]
        };
      }

      case "parties": {
        const r = await this.database.query(
          `SELECT p.party_code, p.name, p.name_kana, p.kind, p.status, p.aliases,
                  p.invoice_no, p.corporate_no, p.withholding, p.legacy_id,
                  (SELECT count(*) FROM conditions c WHERE c.counterparty_id = p.id) AS conditions,
                  (SELECT count(*) FROM payments y WHERE y.party_id = p.id)          AS payments
             FROM parties p ORDER BY p.status, p.name`);
        return {
          rows: r.rows,
          columns: [
            { header: "取引先コード", value: (x: any) => x.party_code },
            { header: "名称", value: (x: any) => x.name },
            { header: "カナ", value: (x: any) => x.name_kana },
            { header: "区分", value: (x: any) => (x.kind === "individual" ? "個人" : "法人") },
            { header: "状態", value: (x: any) => x.status },
            { header: "別名", value: (x: any) => ((x.aliases as string[] | null) ?? []).join(" / ") },
            { header: "インボイス番号", value: (x: any) => x.invoice_no },
            { header: "法人番号", value: (x: any) => x.corporate_no },
            { header: "源泉対象", value: (x: any) => (x.withholding ? "対象" : "") },
            { header: "条件数", value: (x: any) => x.conditions },
            { header: "支払数", value: (x: any) => x.payments },
            { header: "移行元ID", value: (x: any) => x.legacy_id }
          ]
        };
      }

      default:
        throw new DomainError("VALIDATION", `出力できない一覧です: ${dataset}`);
    }
  }
}
