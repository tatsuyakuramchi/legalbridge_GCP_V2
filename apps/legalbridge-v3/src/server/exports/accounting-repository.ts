import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import {
  buildAccountingRow, groupAccounting,
  type AccountingGroup, type AccountingSource, type AllocationLine, type DocumentLine
} from "./accounting.js";

/**
 * 経理提出用の帳票を V3 のデータから読む。
 *
 * V1/V2 は文書の form_data を舐めていたが、V3 は支払・割当・条件・取引先が
 * 列に分かれている。別名キーを推測する必要がないぶん、読み方は素直になる。
 *
 * 担当者と部署は案件から辿る。支払 → 割当 → 条件 → 案件（matter_links）→
 * 担当者。V1 は文書に検収者が書いてあったが、V3 は案件が担当を持つ。
 */

/** 最小通貨単位から主要単位へ。JPY はそのまま、それ以外は 1/100。 */
const major = (amount: unknown, currency: unknown): number => {
  const minor = ["JPY", "KRW", "VND"].includes(String(currency ?? "JPY")) ? 1 : 100;
  const value = Number(amount ?? 0) / minor;
  return minor === 1 ? value : Math.round(value * 100) / 100;
};

export interface AccountingQuery {
  from: string;
  to: string;
  /** どの日付で切るか。paid＝実際に払った日（経理の月次）、due＝期日。 */
  basis?: "due" | "paid";
  /** 出力済みを除くか。既定は除く（V1 の「保留」と同じ考え方）。 */
  includeExported?: boolean;
}

export interface AccountingResult {
  from: string; to: string; basis: "due" | "paid";
  groups: AccountingGroup[];
  count: number;
  /** 要確認の件数。0 でないまま経理へ出さない。 */
  flagged: number;
}

const PAYMENTS_SQL = `
  SELECT y.id, y.payment_no, y.currency, y.amount, y.tax_amount, y.withholding_amount,
         y.due_on, y.paid_on, y.status,
         p.party_code, p.name AS party_name, p.name_kana, p.kind AS party_kind,
         p.invoice_no, p.withholding,
         m.matter_no, m.title AS matter_title,
         s.name AS owner_name, s.department AS owner_department
    FROM payments y
    JOIN parties p ON p.id = y.party_id
    -- 案件は割当の条件から辿る。複数当たったら番号の若い1件に寄せる。
    LEFT JOIN LATERAL (
      SELECT mt.matter_no, mt.title, mt.owner_staff_id
        FROM payment_allocations al
        JOIN matter_links ml ON ml.target_type = 'condition'
                            AND ml.target_ref = al.condition_id::text
        JOIN matters mt ON mt.id = ml.matter_id
       WHERE al.payment_id = y.id
       ORDER BY mt.matter_no NULLS LAST, mt.id
       LIMIT 1
    ) m ON true
    LEFT JOIN staff s ON s.id = m.owner_staff_id
    -- 出力済みかどうかは「最後の記録」で決める。監査記録は追記専用なので、
    -- 取り消しは行を消すのではなく取り消しの記録を足す。
    LEFT JOIN LATERAL (
      SELECT a.action FROM audit_events a
       WHERE a.target_type = 'payment' AND a.target_id = y.id
         AND a.action IN ('export.accounting', 'export.accounting.undo')
       ORDER BY a.id DESC LIMIT 1
    ) ex ON true
   WHERE y.direction = 'out'
     AND (CASE WHEN $3::text = 'paid' THEN y.paid_on ELSE y.due_on END)
         BETWEEN $1::date AND $2::date
     AND ($4::boolean OR ex.action IS DISTINCT FROM 'export.accounting')
   ORDER BY COALESCE(y.paid_on, y.due_on), y.id`;

/**
 * 支払の元になった書類（検収書）の明細。
 *
 * 支払は実績から起こすので、割当の実績を辿ればその実績を載せた書類に着く。
 * V1・V2 は経理の「支払内容」を書類の明細から出していたので、そこを合わせる。
 * 1つの支払が複数の書類にまたがるときは、どれとも決められないので使わない。
 */
const DOCUMENT_SQL = `
  SELECT al.payment_id, count(DISTINCT e.document_id) AS documents,
         min(e.document_id) AS document_id,
         (array_agg(d.rendered_values ORDER BY d.id))[1] AS rendered_values
    FROM payment_allocations al
    JOIN condition_events e ON e.id = al.event_id
    JOIN documents d ON d.id = e.document_id AND d.status = 'issued'
   WHERE al.payment_id = ANY($1::bigint[])
   GROUP BY al.payment_id`;

const LINES_SQL = `
  SELECT al.payment_id, al.amount, c.condition_no, c.name, c.tax_category,
         c.currency, c.unit_amount,
         e.quantity, e.occurred_on
    FROM payment_allocations al
    JOIN conditions c ON c.id = al.condition_id
    LEFT JOIN condition_events e ON e.id = al.event_id
   WHERE al.payment_id = ANY($1::bigint[])
   ORDER BY al.payment_id, c.condition_no NULLS LAST, al.id`;

/**
 * 焼き付けた書類の中身から、経理の支払内容にする行を取り出す。
 *
 * V2 の inspectionSlots と同じ扱いにする。
 *   ・今回検収の行だけを載せる（分納の済んだ回・これからの回は載せない）
 *   ・課税の手数料は行として載せる（非課税は立替金なので載せない）
 */
export function documentLinesFrom(rendered: unknown): DocumentLine[] {
  const values = (rendered ?? {}) as Record<string, unknown>;
  const rowsOf = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  const n = (v: unknown): number | null => {
    if (v === "" || v === null || v === undefined) return null;
    const parsed = Number(String(v).replace(/[,¥\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

  const lines: DocumentLine[] = [];
  for (const row of rowsOf(values.delivery_line_items)) {
    // 分納は「今回の分」だけが支払の対象。済んだ回を混ぜると二重に払う。
    const status = text(row.inspection_status);
    if (status && status !== "now") continue;
    const amount = n(row.inspected_amount_ex_tax ?? row.amount_ex_tax ?? row.amount) ?? 0;
    // 継続課金を周期ごとに割った1行は1期分。数量も単価も持たないので、
    // 空欄や 0 のまま経理へ出さない（V2 の inspectionSlots と同じ扱い）。
    const subscription = text(row.calc_method).toUpperCase() === "SUBSCRIPTION";
    const quantity = n(row.inspected_quantity ?? row.quantity);
    lines.push({
      content: text(row.item_name),
      unitPrice: n(row.unit_price) ?? (subscription && amount > 0 ? amount : null),
      quantity: subscription && amount > 0 && (quantity === null || quantity <= 0) ? 1 : quantity,
      amount,
      deliveryDate: text(row.delivery_date).slice(0, 10) || null
    });
  }
  for (const fee of rowsOf(values.other_fees)) {
    // 非課税の手数料は立替金の側で数える。ここに載せると二重になる。
    if ((text(fee.tax_category) || "taxable") === "exempt") continue;
    lines.push({
      content: text(fee.fee_name ?? fee.item_name ?? fee.name) || "その他手数料",
      unitPrice: null, quantity: null,
      amount: n(fee.amount_ex_tax ?? fee.amount) ?? 0,
      deliveryDate: null
    });
  }
  return lines;
}

export class AccountingExportRepository {
  constructor(private readonly database: Transactable) {}

  async build(query: AccountingQuery): Promise<AccountingResult> {
    const basis = query.basis ?? "due";
    try {
      const heads = await this.database.query(
        PAYMENTS_SQL, [query.from, query.to, basis, query.includeExported === true]);
      const ids = (heads.rows as any[]).map((r) => Number(r.id));

      const lines = ids.length
        ? await this.database.query(LINES_SQL, [ids])
        : { rows: [] as any[] };

      // 書類の明細を先に取る。あれば支払内容はこちらを使う。
      const docLines = new Map<number, DocumentLine[]>();
      if (ids.length) {
        const docs = await this.database.query(DOCUMENT_SQL, [ids]);
        for (const d of docs.rows as any[]) {
          if (Number(d.documents) !== 1) continue;
          const lines = documentLinesFrom(d.rendered_values);
          if (lines.length) docLines.set(Number(d.payment_id), lines);
        }
      }

      const byPayment = new Map<number, AllocationLine[]>();
      for (const l of lines.rows as any[]) {
        const id = Number(l.payment_id);
        const list = byPayment.get(id) ?? [];
        list.push({
          conditionNo: str(l.condition_no),
          name: String(l.name ?? ""),
          taxCategory: (["taxable", "reduced", "exempt"].includes(String(l.tax_category))
            ? String(l.tax_category) : "taxable") as AllocationLine["taxCategory"],
          amount: major(l.amount, l.currency),
          quantity: l.quantity === null || l.quantity === undefined ? null : Number(l.quantity),
          unitAmount: l.unit_amount === null || l.unit_amount === undefined
            ? null : major(l.unit_amount, l.currency),
          occurredOn: dateStr(l.occurred_on)
        });
        byPayment.set(id, list);
      }

      const owners = new Map<number, string>();
      const rows = (heads.rows as any[]).map((r) => {
        const id = Number(r.id);
        owners.set(id, str(r.owner_name) ?? "(担当者未設定)");
        const source: AccountingSource = {
          paymentId: id,
          paymentNo: str(r.payment_no),
          currency: String(r.currency ?? "JPY"),
          amount: major(r.amount, r.currency),
          taxAmount: major(r.tax_amount, r.currency),
          withholdingAmount: major(r.withholding_amount, r.currency),
          dueOn: dateStr(r.due_on),
          paidOn: dateStr(r.paid_on),
          status: String(r.status),
          party: {
            code: str(r.party_code), name: String(r.party_name ?? ""),
            kana: str(r.name_kana),
            kind: r.party_kind === "individual" ? "individual" : "corporate",
            invoiceNo: str(r.invoice_no), withholding: r.withholding === true
          },
          ownerName: str(r.owner_name),
          ownerDepartment: str(r.owner_department),
          matterNo: str(r.matter_no),
          matterTitle: str(r.matter_title),
          lines: byPayment.get(id) ?? [],
          documentLines: docLines.get(id)
        };
        return buildAccountingRow(source);
      });

      const groups = groupAccounting(rows, owners);
      return {
        from: query.from, to: query.to, basis, groups,
        count: rows.length,
        flagged: rows.filter((r) => r.flags.length).length
      };
    } catch (error) { throw translate(error); }
  }
}

/**
 * 出力済みにする。
 *
 * V1・V2 は専用の台帳表（lb_v2_excel_export_ledger）を持っていた。V3 は
 * audit_events に残す。「誰がいつ何を出したか」を残す場所を増やさない。
 * 二度同じ支払を出しても記録は1つ（冪等キーで弾く）。
 */
export class AccountingExportLedger {
  constructor(private readonly database: Transactable) {}

  async markExported(paymentIds: number[], batchKey: string, actor: string): Promise<number> {
    return this.record(paymentIds, "export.accounting", actor, batchKey);
  }

  /**
   * 出力済みを取り消す。間違って出したときに戻せないと運用が詰まる。
   * 記録を消すのではなく、取り消した記録を足す（監査記録は追記専用）。
   */
  async unmark(paymentIds: number[], actor: string): Promise<number> {
    return this.record(paymentIds, "export.accounting.undo", actor, "");
  }

  /** 状態が変わるときだけ書く。二度押しても記録は増えない。 */
  private async record(
    paymentIds: number[], action: "export.accounting" | "export.accounting.undo",
    actor: string, batchKey: string
  ): Promise<number> {
    const ids = [...new Set(paymentIds.map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return 0;
    try {
      const r = await this.database.query(
        // 列名は t.payment_id と明示する。unnest(...) AS id と書くと、
        // 内側の audit_events.id が優先されて別のものを見に行く。
        `INSERT INTO audit_events (actor, action, target_type, target_id, detail)
         SELECT $2, $4, 'payment', t.payment_id, jsonb_build_object('batchKey', $3::text)
           FROM unnest($1::bigint[]) AS t(payment_id)
          WHERE COALESCE((
                  SELECT a.action FROM audit_events a
                   WHERE a.target_type = 'payment' AND a.target_id = t.payment_id
                     AND a.action IN ('export.accounting', 'export.accounting.undo')
                   ORDER BY a.id DESC LIMIT 1
                ), '') IS DISTINCT FROM $4`,
        [ids, actor, batchKey || null, action]);
      return r.rowCount ?? 0;
    } catch (error) { throw translate(error); }
  }
}
