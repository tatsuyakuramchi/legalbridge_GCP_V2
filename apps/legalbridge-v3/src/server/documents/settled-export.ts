import { type Queryable, dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { SETTLED_COLUMNS, toCsv } from "./settled-batch.js";

/**
 * 案件の現物を、遡及一括取込の CSV で書き出す。
 *
 * 「発注書と検収書は出してあるが、金額が一部違う。作り直したい」という
 * ときのための口。直すには同じ内容の CSV が要るが、13人ぶん26列を手で
 * 打つと、そこで転記を間違える（実際に1文字違いのコマンドで500を出した）。
 * いま台帳にあるものをそのまま吐いて、表計算で金額だけ直して入れ直す。
 *
 * 読むだけ。ここでは何も作らないし、何も消さない。
 *
 * 明細は紙（発注書の rendered_values.items）を先に見る。台帳の条件より、
 * 実際に相手へ出した紙のほうが「何を頼んだか」に近い。紙が無ければ条件と
 * 実績から組む。
 */

/** CSV の1行。鍵は SETTLED_COLUMNS のもの。 */
export type ExportRow = Record<string, unknown>;

export interface ExportNote {
  conditionNo: string | null;
  conditionName: string;
  /** 人が見ないと決められないこと。CSV には出ない。 */
  note: string;
}

export interface SettledExport {
  matter: { id: number; matterNo: string | null; title: string };
  rows: ExportRow[];
  notes: ExportNote[];
  csv: string;
}

interface CondRow {
  id: number; condition_no: string | null; name: string; kind: string;
  unit_amount: unknown; flat_amount: unknown; quantity: unknown;
  payment_terms: string | null; contract_form: string | null;
  deliverable_ownership: string | null;
  party_code: string | null; party_name: string | null;
  work_code: string | null; work_title: string | null;
  agreement_no: string | null;
}

interface DocRow { id: number; document_no: string | null; issued_at: unknown; values: unknown }
interface EventRow {
  id: number; occurred_on: unknown; quantity: unknown; amount: unknown;
  deliverable: string | null; note: string | null; document_id: number | null;
}
interface PayRow { status: string; due_on: unknown; paid_on: unknown }

export class SettledExportService {
  constructor(private readonly database: Queryable) {}

  async forMatter(matterId: number): Promise<SettledExport> {
    try {
      const head = await this.database.query(
        "SELECT id, matter_no, title FROM matters WHERE id = $1", [matterId]);
      const matter = head.rows[0] as { id: number; matter_no: string | null; title: string } | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      const conds = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.kind,
                c.unit_amount, c.flat_amount, c.quantity,
                c.payment_terms, c.contract_form, c.deliverable_ownership,
                p.party_code, p.name AS party_name,
                w.work_code, w.title AS work_title,
                a.agreement_no
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works   w ON w.id = c.work_id
           LEFT JOIN agreements a ON a.id = c.agreement_id
          WHERE c.status IN ('active', 'draft', 'scheduled')
            AND EXISTS (SELECT 1 FROM matter_links ml
                         WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
                           AND ml.target_ref = c.id::text)
          ORDER BY p.name, c.id`, [matterId]);

      const rows: ExportRow[] = [];
      const notes: ExportNote[] = [];
      for (const cond of conds.rows as unknown as CondRow[]) {
        const made = await this.rowsFor(cond);
        rows.push(...made.rows);
        notes.push(...made.notes);
      }

      return {
        matter: { id: Number(matter.id), matterNo: str(matter.matter_no),
                  title: String(matter.title ?? "") },
        rows, notes, csv: toCsv(rows)
      };
    } catch (error) { throw translate(error); }
  }

  /** 条件1本ぶんの行。紙があれば紙の明細、無ければ実績、どちらも無ければ条件そのもの。 */
  private async rowsFor(cond: CondRow): Promise<{ rows: ExportRow[]; notes: ExportNote[] }> {
    const notes: ExportNote[] = [];
    const say = (note: string) =>
      notes.push({ conditionNo: str(cond.condition_no), conditionName: cond.name, note });

    // 発注書。items を持つ、無効でない文書のうち新しいもの。
    const orders = await this.database.query(
      `SELECT d.id, d.document_no, d.issued_at, d.rendered_values AS values
         FROM documents d
         JOIN document_conditions dc ON dc.document_id = d.id
        WHERE dc.condition_id = $1 AND d.status <> 'void'
          AND jsonb_typeof(d.rendered_values -> 'items') = 'array'
          -- delivery_line_items を持つのは決済文書。発注書だけを拾う。
          -- 鍵が無いと jsonb_typeof は NULL を返し、NULL <> 'array' は真に
          -- ならない（NULL のまま）。IS DISTINCT FROM で受け止める。
          AND jsonb_typeof(d.rendered_values -> 'delivery_line_items') IS DISTINCT FROM 'array'
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [cond.id]);
    const order = (orders.rows as unknown as DocRow[])[0] ?? null;
    if ((orders.rows as unknown as DocRow[]).length > 1) {
      say(`発注書が ${orders.rows.length} 枚あります。いちばん新しい `
        + `${str(order?.document_no) ?? "（番号なし）"} の明細で書き出しました`);
    }

    const events = await this.database.query(
      `SELECT e.id, e.occurred_on, e.quantity, e.amount, e.deliverable, e.note, e.document_id
         FROM condition_events e
        WHERE e.condition_id = $1 AND e.status = 'active'
        ORDER BY e.occurred_on, e.id`, [cond.id]);
    const eventRows = events.rows as unknown as EventRow[];

    // 決済文書（検収書・計算書）。実績が結ばれている先。
    const settle = await this.database.query(
      `SELECT d.id, d.document_no, d.issued_at, d.rendered_values AS values
         FROM documents d
        WHERE d.status <> 'void'
          AND EXISTS (SELECT 1 FROM condition_events e
                       WHERE e.document_id = d.id AND e.condition_id = $1 AND e.status = 'active')
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [cond.id]);
    const inspection = (settle.rows as unknown as DocRow[])[0] ?? null;

    const pays = await this.database.query(
      `SELECT y.status, y.due_on, y.paid_on
         FROM payments y
        WHERE y.status <> 'canceled'
          AND EXISTS (SELECT 1 FROM payment_allocations al
                       JOIN condition_events e ON e.id = al.event_id
                      WHERE al.payment_id = y.id AND e.condition_id = $1)
        ORDER BY y.id DESC`, [cond.id]);
    const payment = (pays.rows as unknown as PayRow[])[0] ?? null;

    const base = {
      partyCode: str(cond.party_code) ?? "",
      partyName: str(cond.party_name) ?? "",
      workCode: str(cond.work_code) ?? "",
      workTitle: str(cond.work_title) ?? "",
      // 基本契約が無い発注は「なし」と書く。空だと取引先から自動で当てにいく。
      agreementNo: str(cond.agreement_no) ?? "なし",
      // 条件名は必ず書く。空にすると取り込みが同じ取引先・作品の条件を
      // 1本にまとめてしまい、人ごとに分かれている13本が崩れる。
      conditionName: cond.name,
      orderedOn: dateStr(order?.issued_at) ?? "",
      inspectedOn: dateStr(inspection?.issued_at) ?? "",
      dueOn: dateStr(payment?.due_on) ?? "",
      paymentState: payStateOf(payment),
      paidOn: dateStr(payment?.paid_on) ?? "",
      payment_terms: str(cond.payment_terms) ?? "",
      deliverable_ownership: OWNERSHIP_LABEL[String(cond.deliverable_ownership ?? "")] ?? "",
      orderSign: "", acceptSign: "", specialTermsSnippet: "", specialTerms: "", remarks: ""
    };

    if (!base.orderedOn) say("発注書が見つかりません。発注日を入れてください");
    if (!base.inspectedOn) say("検収書が見つかりません。検収日を入れてください");

    const items = itemsOf(order?.values);
    const delivery = itemsOf(inspection?.values, "delivery_line_items");

    // ① 紙の明細がある。1行が1明細。
    if (items.length) {
      return { rows: items.map((item, i) => {
        const ev = eventRows[i] ?? null;
        const del = delivery[i] ?? null;
        const quantity = num(item.quantity) ?? 1;
        const unitPrice = num(item.unit_price)
          ?? divide(num(item.amount_ex_tax), quantity)
          ?? num(cond.unit_amount) ?? num(cond.flat_amount);
        const name = str(item.item_name) ?? cond.name;
        return {
          ...base,
          item_name: name,
          spec: str(item.spec) ?? str(item.description) ?? "",
          quantity: fmtNum(quantity),
          unit_price: fmtNum(unitPrice),
          deliveredOn: dateStr(ev?.occurred_on) ?? base.inspectedOn,
          inspectedQuantity: fmtNum(
            inspectedQtyOf({ quantity, unitPrice, del, ev, name, say })),
          varianceNote: str(del?.changeNote) ?? str(ev?.note) ?? "",
          contract_form: str(item.payment_terms) ?? str(cond.contract_form) ?? "",
          deliverable_ownership:
            OWNERSHIP_LABEL[String(item.deliverable_ownership ?? "")] ?? base.deliverable_ownership
        };
      }), notes };
    }

    // ② 紙は無いが実績はある。実績1件が1行。
    if (eventRows.length) {
      say("発注書の明細が読めないので、実績から組みました。品目名を確かめてください");
      return { rows: eventRows.map((ev) => {
        const quantity = num(ev.quantity) ?? 1;
        return {
          ...base,
          item_name: str(ev.deliverable) ?? cond.name,
          spec: "",
          quantity: fmtNum(quantity),
          unit_price: fmtNum(divide(num(ev.amount), quantity) ?? num(cond.unit_amount)),
          deliveredOn: dateStr(ev.occurred_on) ?? "",
          inspectedQuantity: "",
          varianceNote: str(ev.note) ?? "",
          contract_form: str(cond.contract_form) ?? ""
        };
      }), notes };
    }

    // ③ どちらも無い。条件そのものを1行にする。
    say("紙も実績もありません。条件の金額で1行にしました");
    return { rows: [{
      ...base,
      item_name: cond.name, spec: "",
      quantity: fmtNum(num(cond.quantity) ?? 1),
      unit_price: fmtNum(num(cond.unit_amount) ?? num(cond.flat_amount)),
      deliveredOn: "", inspectedQuantity: "", varianceNote: "",
      contract_form: str(cond.contract_form) ?? ""
    }], notes };
  }
}

// ---------------------------------------------------------------------------

/**
 * その行の検収数量。数量どおりに納まっていれば空（取り込みが数量に揃える）。
 *
 * 減額検収は数量で持つ決まりだが、台帳には**金額でしか**減額が残っていない
 * ことがある（数量が空のまま、実績の額だけ下がっている）。手元の写しの
 * ARC-IN-2026-0005 がそれで、発注 96,000 に対し実績 88,000、数量はどちらも空。
 * これを見落として数量をそのまま書き出すと、**発注どおりの高い額で紙を
 * 作り直す**ことになる。金額を直す目的で書き出しているのに、いちばん危ない
 * 取り違えがそこで起きる。
 *
 * なので単価で割り戻す。割り切れないときは空のままにして、人に決めてもらう
 * （推測で数量を書くと、紙の合計と単価×数量が合わない行ができる）。
 */
export function inspectedQtyOf(input: {
  quantity: number;
  unitPrice: number | null;
  del: Record<string, unknown> | null;
  ev: { amount?: unknown } | null;
  name: string;
  say: (note: string) => void;
}): number | null {
  const { quantity, unitPrice, del, ev, name, say } = input;
  const told = num(del?.inspected_quantity) ?? num((ev as { quantity?: unknown } | null)?.quantity);
  if (told !== null) return told === quantity ? null : told;

  const paid = num(ev?.amount);
  if (paid === null || !unitPrice || unitPrice <= 0) return null;
  const ordered = unitPrice * quantity;
  if (paid === ordered) return null;

  const derived = paid / unitPrice;
  if (Number.isInteger(derived) && derived > 0) return derived;

  say(`「${name}」は発注 ${ordered.toLocaleString()} 円に対して実績が `
    + `${paid.toLocaleString()} 円ですが、単価で割り切れません。`
    + "検収数量を入れてください（空のままだと発注どおりの額で作り直されます）");
  return null;
}

const OWNERSHIP_LABEL: Record<string, string> = { orderer: "発注者", contractor: "受注者" };

/** 支払の状態を CSV の言葉に直す。支払が無ければ「なし」（検収書まで作る）。 */
export function payStateOf(payment: { status: string; paid_on?: unknown } | null): string {
  if (!payment) return "なし";
  return payment.status === "paid" ? "支払済み" : "未払";
}

/** rendered_values の明細。配列でなければ空。 */
export function itemsOf(values: unknown, key = "items"): Array<Record<string, unknown>> {
  if (!values || typeof values !== "object") return [];
  const list = (values as Record<string, unknown>)[key];
  return Array.isArray(list)
    ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    : [];
}

/** 0 で割らない。割れなければ null（空欄で出して人に入れてもらう）。 */
const divide = (total: number | null, by: number): number | null =>
  total !== null && by > 0 ? Math.round(total / by) : null;

/** CSV の数値。空は空のまま出す（0 と空欄は意味が違う）。 */
const fmtNum = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : String(v);

export { SETTLED_COLUMNS };
