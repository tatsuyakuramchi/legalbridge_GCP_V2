import { type Queryable, dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { SETTLED_COLUMNS, readRows, toCsv } from "./settled-batch.js";

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

/**
 * 何を作り直すのか。
 *
 * as_is … 現物どおり。当初の発注数量と検収数量の差も、そのまま写す。
 *         紙に「変更内容の確認」が出ていた取引を、そのまま作り直すとき。
 *
 * first_edition … 初版として出す。検収まで終わっている取引を「いま文書化する」
 *         のであって、当初からの変更ではない。数量は実際に検収した数にして、
 *         検収数量と変更理由は空にする。発注書と検収書が同じ数を言うので、
 *         紙に「変更内容の確認」は出ない。
 *
 *         RR241 のように「紙が無い／金額が違うので、事実どおりに作り直す」
 *         場合はこちら。as_is で出すと、起きていない減額を紙に刷ることになり、
 *         そのうえ取り込みが変更理由を要求してくる。
 */
export type ExportMode = "as_is" | "first_edition";

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
  payment_terms: string | null; contract_form: string | null; delivery_due: unknown;
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
interface PayRow { status: string; due_on: unknown; paid_on: unknown; event_id?: unknown }

export class SettledExportService {
  constructor(private readonly database: Queryable) {}

  async forMatter(matterId: number, mode: ExportMode = "as_is"): Promise<SettledExport> {
    try {
      const head = await this.database.query(
        "SELECT id, matter_no, title FROM matters WHERE id = $1", [matterId]);
      const matter = head.rows[0] as { id: number; matter_no: string | null; title: string } | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      const conds = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.kind,
                c.unit_amount, c.flat_amount, c.quantity,
                c.payment_terms, c.contract_form, c.deliverable_ownership, c.delivery_due,
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
        const made = await this.rowsFor(cond, mode);
        rows.push(...made.rows);
        notes.push(...made.notes);
      }

      const csv = toCsv(rows);
      return {
        matter: { id: Number(matter.id), matterNo: str(matter.matter_no),
                  title: String(matter.title ?? "") },
        rows, notes: [...notes, ...importIssues(csv, rows)], csv
      };
    } catch (error) { throw translate(error); }
  }

  /** 条件1本ぶんの行。紙があれば紙の明細、無ければ実績、どちらも無ければ条件そのもの。 */
  private async rowsFor(
    cond: CondRow, mode: ExportMode
  ): Promise<{ rows: ExportRow[]; notes: ExportNote[] }> {
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
    const settleDocs = settle.rows as unknown as DocRow[];
    const inspection = settleDocs[0] ?? null;
    // 検収書は条件に何枚もある（1枚の発注書に検収が何回か）。実績ごとに、
    // その実績が結ばれている検収書を引く。1枚目に全部寄せると、別の回の
    // 検収日や検収数量が写る。
    const docById = new Map(settleDocs.map((d) => [String(d.id), d]));
    const docOf = (ev: EventRow | null): DocRow | null =>
      (ev?.document_id !== null && ev?.document_id !== undefined
        ? docById.get(String(ev.document_id)) : null) ?? inspection;
    // その検収書の中で何行目の実績か（納品明細と同じ並び）。
    const indexInDoc = (ev: EventRow): number =>
      eventRows.filter((e) => String(e.document_id) === String(ev.document_id))
        .findIndex((e) => String(e.id) === String(ev.id));

    // 支払も実績ごと（決済の組ごとに1件）。実績が分からなければ新しいもの。
    const pays = await this.database.query(
      `SELECT y.status, y.due_on, y.paid_on, al.event_id
         FROM payments y
         JOIN payment_allocations al ON al.payment_id = y.id
         JOIN condition_events e ON e.id = al.event_id
        WHERE y.status <> 'canceled' AND e.condition_id = $1
        ORDER BY y.id DESC`, [cond.id]);
    const payRows = pays.rows as unknown as PayRow[];
    const payment = payRows[0] ?? null;
    const payOf = (ev: EventRow | null): PayRow | null =>
      (ev ? payRows.find((y) => String(y.event_id) === String(ev.id)) : null) ?? payment;

    const base = {
      partyCode: str(cond.party_code) ?? "",
      partyName: str(cond.party_name) ?? "",
      workCode: str(cond.work_code) ?? "",
      workTitle: str(cond.work_title) ?? "",
      // 基本契約が無い発注は「なし」と書く。空だと取引先から自動で当てにいく。
      agreementNo: str(cond.agreement_no) ?? "なし",
      // 条件番号を必ず書く。名前だけだと、同名の条件が2本ある取引先で
      // 取り違える。番号があれば取り込みはその1本に確実に載せる。
      conditionNo: str(cond.condition_no) ?? "",
      // 旧分の既定。紙か実績か支払を持っている条件だけ「畳む」を入れておく。
      // 作り直しのために書き出しているので、持っていれば畳む相手がいる。
      // 「無効」（条件も畳む）は入れない。重複かどうかは人にしか決められない。
      oldHandling: "",
      // 条件名も書く。番号の無い条件（新しく作る行）でも束が分かれるように。
      conditionName: cond.name,
      orderedOn: dateStr(order?.issued_at) ?? "",
      inspectedOn: dateStr(inspection?.issued_at) ?? "",
      // 納期は条件が持っている。紙の納品日（実際に納まった日）とは別。
      deliveryDue: dateStr(cond.delivery_due) ?? "",
      dueOn: dateStr(payment?.due_on) ?? "",
      paymentState: payStateOf(payment),
      paidOn: dateStr(payment?.paid_on) ?? "",
      payment_terms: str(cond.payment_terms) ?? "",
      deliverable_ownership: OWNERSHIP_LABEL[String(cond.deliverable_ownership ?? "")] ?? "",
      orderSign: "", acceptSign: "", specialTermsSnippet: "", specialTerms: "", remarks: ""
    };

    if (!base.orderedOn) say("発注書が見つかりません。発注日を入れてください");
    if (!base.inspectedOn) say("検収書が見つかりません。検収日を入れてください");

    if (order || inspection || payment || eventRows.length) base.oldHandling = "畳む";

    const line = await this.linesFor(cond, order, say);
    const items = line.items;
    // 実費・手数料の行は発注書の items と並びが揃っていない。検収書の
    // 納品明細を番号で当てると、別の品目の検収数量を写してしまう。
    const delivery = line.ownLines ? [] : itemsOf(inspection?.values, "delivery_line_items");

    // ① 紙の明細がある。1行が1明細。
    // 実績は品目名（納品物）で当て、当たらなければ並び順で当てる。
    // まとめて入れた取引は納品物に品目名が入っているので、検収が何回かに
    // 分かれていても、その品目の実績・検収書・支払に正しく当たる。
    if (items.length) {
      const norm = (v: unknown) => String(v ?? "").replace(/[\s\u3000]+/g, "").toLowerCase();
      const taken = new Set<string>();
      const eventFor = (item: Record<string, unknown>, i: number): EventRow | null => {
        const byName = eventRows.filter((e) =>
          !taken.has(String(e.id)) && norm(e.deliverable) && norm(e.deliverable) === norm(item.item_name));
        const ev = byName.length === 1 ? byName[0]
          : (eventRows[i] && !taken.has(String(eventRows[i].id)) ? eventRows[i] : null);
        if (ev) taken.add(String(ev.id));
        return ev;
      };
      return { rows: items.map((item, i) => {
        const ev = eventFor(item, i);
        const evDoc = docOf(ev);
        const evPay = payOf(ev);
        const del = line.ownLines ? null
          : ev && evDoc ? (itemsOf(evDoc.values, "delivery_line_items")[indexInDoc(ev)] ?? null)
          : delivery[i] ?? null;
        const quantity = num(item.quantity) ?? 1;
        const unitPrice = num(item.unit_price)
          ?? divide(num(item.amount_ex_tax), quantity)
          ?? num(cond.unit_amount) ?? num(cond.flat_amount);
        const name = str(item.item_name) ?? cond.name;
        const inspected = inspectedQtyOf({ quantity, unitPrice, del, ev, name, say });
        const settled = firstEditionLine({
          mode, quantity, unitPrice, inspected, amount: num(ev?.amount), name, say
        });
        return {
          ...base,
          // 検収日と支払は、その実績の検収書・支払のもの（回ごとに違う）。
          inspectedOn: dateStr(evDoc?.issued_at) ?? base.inspectedOn,
          dueOn: dateStr(evPay?.due_on) ?? (ev ? "" : base.dueOn),
          paymentState: ev ? payStateOf(evPay) : base.paymentState,
          paidOn: dateStr(evPay?.paid_on) ?? (ev ? "" : base.paidOn),
          item_name: name,
          spec: str(item.spec) ?? str(item.description) ?? "",
          quantity: fmtNum(settled.quantity),
          unit_price: fmtNum(settled.unitPrice),
          deliveredOn: dateStr(ev?.occurred_on) ?? base.inspectedOn,
          inspectedQuantity: fmtNum(settled.inspected),
          // 初版は「当初からの変更」ではないので、変更理由も持たせない。
          varianceNote: mode === "first_edition"
            ? "" : str(del?.changeNote) ?? str(ev?.note) ?? "",
          // 版は行ごとに書く。同じ案件でも、初版で出す行と変更として残す行が
          // 混ざる（当初から減っていた人と、紙が無いだけの人）。
          revision: mode === "first_edition" ? "初版"
            : settled.inspected !== null ? "変更履歴付" : "初版",
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
        const evDoc = docOf(ev);
        const evPay = payOf(ev);
        return {
          ...base,
          inspectedOn: dateStr(evDoc?.issued_at) ?? base.inspectedOn,
          dueOn: dateStr(evPay?.due_on) ?? "",
          paymentState: payStateOf(evPay),
          paidOn: dateStr(evPay?.paid_on) ?? "",
          item_name: str(ev.deliverable) ?? cond.name,
          spec: "",
          quantity: fmtNum(quantity),
          unit_price: fmtNum(divide(num(ev.amount), quantity) ?? num(cond.unit_amount)),
          deliveredOn: dateStr(ev.occurred_on) ?? "",
          inspectedQuantity: "",
          varianceNote: str(ev.note) ?? "",
          // 紙が無いので、当初との差そのものが無い。
          revision: "初版",
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
      deliveredOn: "", inspectedQuantity: "", varianceNote: "", revision: "初版",
      contract_form: str(cond.contract_form) ?? ""
    }], notes };
  }

  /**
   * 発注書の明細のうち、**この条件のもの**。
   *
   * 1枚の発注書に何本かの条件がぶら下がることがある。業務委託は
   * 委託料・実費・手数料が組で動き、実費と手数料の条件は発注書を決めた
   * ときに自動でできて、同じ紙に繋がる。このとき items に載っているのは
   * 委託料の明細だけで、実費と手数料は other_fees / expenses に条件番号
   * つきで載っている。
   *
   * 何も分けずに items をそのまま返すと、同じ明細が条件の数だけ複製され、
   * 書き出した CSV の合計が実際の何倍にもなる。そのまま上げ直せば、
   * 払っていない額の紙が刷られる。
   */
  private async linesFor(
    cond: CondRow, order: DocRow | null, say: (note: string) => void
  ): Promise<{ items: Array<Record<string, unknown>>; ownLines: boolean }> {
    const items = itemsOf(order?.values);
    if (!order) return { items, ownLines: false };
    // conditions.id は bigint。node-postgres は文字列で返すので、
    // 数として揃えてから比べる（=== で比べると必ず外れる）。
    const myId = int(cond.id);

    // 実費・手数料は items に出ない。自分の行を条件番号で拾う。
    if (isOwnLineKind(cond.kind)) {
      const own = [
        ...itemsOf(order.values, "other_fees").map((r) => ({
          item_name: str(r.fee_name) ?? cond.name, quantity: 1,
          unit_price: num(r.amount), condition_id: r.condition_id,
          spec: "", remarks: str(r.remarks) ?? ""
        })),
        ...itemsOf(order.values, "expenses").map((r) => ({
          item_name: str(r.expense_name) ?? cond.name, quantity: 1,
          // 経費は税込の実費。税を重ねない。
          unit_price: num(r.amount_inc_tax), condition_id: r.condition_id,
          spec: "", remarks: str(r.remarks) ?? ""
        }))
      ].filter((r) => int(r.condition_id) === myId);
      if (own.length) return { items: own, ownLines: true };
      // 紙に自分の行が無いなら、実績か条件から組む（②③へ落とす）。
      return { items: [], ownLines: true };
    }

    const linked = await this.database.query(
      `SELECT c.id, c.kind, c.name
         FROM document_conditions dc
         JOIN conditions c ON c.id = dc.condition_id
        WHERE dc.document_id = $1`, [order.id]);
    const others = (linked.rows as unknown as Array<{ id: number; kind: string; name: string }>)
      .filter((c) => int(c.id) !== myId && !isOwnLineKind(c.kind));
    // 1本しかぶら下がっていない（ふつうの発注書）。分ける必要がない。
    if (!others.length) return { items, ownLines: false };

    // 委託料の条件が2本以上ある紙。品目名で、自分にいちばん近い明細だけを
    // 自分の行にする。「挿絵」と「表紙 挿絵」のように部分一致で両方に当たる
    // 名前があるので、他の条件のほうが近い明細は取らない（取ると複製が戻る）。
    const mine = items.filter((it) => {
      const name = str(it.item_name);
      const me = labelScore(name, cond.name);
      if (!me) return false;
      return others.every((o) => labelScore(name, o.name) < me);
    });
    if (mine.length) return { items: mine, ownLines: false };

    say(`発注書 ${str(order.document_no) ?? `#${order.id}`} には条件が `
      + `${others.length + 1} 本ぶら下がっていて、どの明細がこの条件のものか`
      + `決められません。紙は写さず、実績か条件から組みました`);
    return { items: [], ownLines: false };
  }
}

/** 発注書の items に出ない種類。自分の行は other_fees / expenses にある。 */
const isOwnLineKind = (kind: unknown): boolean => kind === "fee" || kind === "expense";

/**
 * 品目名が条件名にどれだけ近いか。2＝同じ、1＝片方がもう片方を含む、0＝別物。
 * 空白と全角半角の揺れは均す。
 */
function labelScore(item: string | null, cond: string | null): number {
  const norm = (v: string | null) => String(v ?? "").replace(/[\s\u3000]+/g, "").toLowerCase();
  const x = norm(item), y = norm(cond);
  if (!x || !y) return 0;
  if (x === y) return 2;
  return x.includes(y) || y.includes(x) ? 1 : 0;
}

// ---------------------------------------------------------------------------

/**
 * 書き出した CSV を、取り込みと同じ目で読み直して不備を拾う。
 *
 * 台帳から素直に書き出すと、取り込みが受け付けない行ができることがある。
 * 実際に出たのは「検収数量が数量と違うのに変更理由が空」。減額は台帳では
 * 金額にしか残っておらず、理由の文は紙のどこにも無いので、書き出しようが
 * ない。それでも取り込みは理由を要る。
 *
 * 上げ直してから「飛ばす」と言われても、そこで初めて気づくことになる。
 * 書き出した時点で、取り込みが何を言うかを先に出す。
 */
export function importIssues(csv: string, rows: ExportRow[]): ExportNote[] {
  let read;
  try { read = readRows(csv); } catch { return []; }
  const out: ExportNote[] = [];
  for (const [i, row] of read.entries()) {
    if (!row.issues.length) continue;
    const source = rows[i] ?? {};
    out.push({
      conditionNo: null,
      conditionName: String(source.conditionName ?? ""),
      note: `「${String(source.item_name ?? "")}」は、このままでは取り込みに弾かれます：`
        + row.issues.join("／")
    });
  }
  return out;
}

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

/**
 * 初版として出すときの数量と単価。
 *
 * 検収まで終わっている取引を「いま文書化する」のだから、発注書も検収書も
 * 実際に検収した数を言えばよい。数量を当初のまま残して検収数量で減らすと、
 * 起きていない減額を紙に刷ることになる。
 *
 * 単価で割り切れない額（発注 96,000 に対して実績 90,000 など）は、数量では
 * 表せない。1式としてその額を単価に置く。刻みが失われるので、そう書き添える。
 */
export function firstEditionLine(input: {
  mode: ExportMode;
  quantity: number;
  unitPrice: number | null;
  inspected: number | null;
  amount: number | null;
  name: string;
  say: (note: string) => void;
}): { quantity: number; unitPrice: number | null; inspected: number | null } {
  const { mode, quantity, unitPrice, inspected, amount, name, say } = input;
  if (mode !== "first_edition") return { quantity, unitPrice, inspected };

  // 実際に検収した数が分かる（発注どおりも含む）。その数で1本にする。
  if (inspected !== null) return { quantity: inspected, unitPrice, inspected: null };

  // 数で表せない。1式として実額を置く。
  if (amount !== null && unitPrice !== null && amount !== unitPrice * quantity) {
    say(`「${name}」は数量では表せない額（${amount.toLocaleString()} 円）なので、`
      + "1式として単価に置きました。数量と単価の刻みが要るなら手で直してください");
    return { quantity: 1, unitPrice: amount, inspected: null };
  }
  return { quantity, unitPrice, inspected: null };
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
