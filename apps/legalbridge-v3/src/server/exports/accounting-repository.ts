import { withholdingPartyOf } from "../royalty/tax.js";
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

/**
 * 書類の当社担当者。文書の画面で選んだ担当（manual_inputs._ownerStaffId）→
 * 書類の案件の担当 → 書類を決定した人（issued_by のメール）。本文の担当者欄と同じ順。
 */
const DOCUMENT_OWNER_SQL = `COALESCE(
           CASE WHEN (d.manual_inputs->>'_ownerStaffId') ~ '^[0-9]+$'
                THEN (d.manual_inputs->>'_ownerStaffId')::bigint END,
           dm.owner_staff_id,
           (SELECT st.id FROM staff st
             WHERE d.issued_by IS NOT NULL AND lower(st.email) = lower(d.issued_by)
             ORDER BY st.id LIMIT 1))`;

/**
 * 社内の担当者（経理提出用）。紙には出さない。経理提出の画面で付け替える
 * （PUT /documents/:id/account-owner）。付けてあれば、案件の担当より優先する。
 */
const ACCOUNT_OWNER_SQL = `CASE WHEN (d.manual_inputs->>'_accountOwnerStaffId') ~ '^[0-9]+$'
           THEN (d.manual_inputs->>'_accountOwnerStaffId')::bigint END`;

/** 書類に刷った件名。ひな形ごとに名前が違うので、件名らしい欄を順に見る。 */
const TITLE_KEYS = ["件名", "title", "PROJECT_TITLE", "projectTitle", "CONTRACT_TITLE",
                    "contractTitle", "基本契約名"];

export function documentTitleFrom(values: unknown, templateKey?: string | null): string | null {
  const v = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
  const pick = (key: string) => (typeof v[key] === "string" ? (v[key] as string).trim() : "");
  // 利用許諾料計算書の件名は「◯◯ 利用許諾料のご報告」（◯◯は原作名）。ひな形の件名の行と同じ形にする。
  if (/statement/.test(String(templateKey ?? ""))) {
    const original = pick("originalWork") || pick("原作名") || pick("原著作物名");
    return original ? `${original} 利用許諾料のご報告` : (pick("件名") || "利用許諾料のご報告");
  }
  for (const key of TITLE_KEYS) {
    const t = pick(key);
    if (t) return t;
  }
  return null;
}

const PAYMENTS_SQL = `
  SELECT y.id, y.payment_no, y.currency, y.amount, y.tax_amount, y.withholding_amount,
         y.due_on, y.paid_on, y.status,
         p.party_code, p.name AS party_name, p.name_kana, p.kind AS party_kind,
         p.invoice_no, p.withholding,
         p.residency, p.treaty_rate_pct, p.treaty_docs_received_on,
         -- 氏名（カナ）は V1・V2 と同じく振込口座の名義カナを出す。経理はこの
         -- 列を振込名義の照合に使う。口座が無いときだけ取引先のカナで代える。
         b.account_holder_kana,
         m.matter_no, m.title AS matter_title,
         s.name AS owner_name, s.department AS owner_department, s.email AS owner_email
    FROM payments y
    JOIN parties p ON p.id = y.party_id
    LEFT JOIN party_bank_accounts b ON b.party_id = p.id
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
     -- 取り消した支払は経理へ出さない。行は記録として残してあるだけで、
     -- 払う約束ではない。混ぜると、立て直した支払と並んで同じ額が2回出る。
     AND y.status <> 'canceled'
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
         (array_agg(d.rendered_values ORDER BY d.id))[1] AS rendered_values,
         (array_agg(d.document_no ORDER BY d.id))[1] AS document_no,
         (array_agg(t.template_key ORDER BY d.id))[1] AS template_key,
         (array_agg(${DOCUMENT_OWNER_SQL} ORDER BY d.id))[1] AS owner_staff_id,
         (array_agg(${ACCOUNT_OWNER_SQL} ORDER BY d.id))[1] AS account_owner_staff_id
    FROM payment_allocations al
    JOIN condition_events e ON e.id = al.event_id
    JOIN documents d ON d.id = e.document_id AND d.status = 'issued'
    LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN document_templates t ON t.id = tv.template_id
    LEFT JOIN matters dm ON dm.id = d.matter_id
   WHERE al.payment_id = ANY($1::bigint[])
   GROUP BY al.payment_id`;

/**
 * 実績から書類に辿れない支払の書類。支払を立てたときの監査記録に、元の書類が
 * 残っている（payment.create の detail.documentId）。
 *
 * 利用許諾料計算書から立てた支払は、実績が計算書に結ばれていない（報告だけの回・
 * 訂正版で実績が移った回）と上の経路で書類が見つからず、帳票が「書類なし」になり、
 * 種別・件名・担当者・PDF の同梱がすべて抜けていた。
 */
const DOCUMENT_BY_AUDIT_SQL = `
  SELECT DISTINCT ON (a.target_id)
         a.target_id AS payment_id, 1 AS documents, d.id AS document_id,
         d.rendered_values, d.document_no, t.template_key,
         ${DOCUMENT_OWNER_SQL} AS owner_staff_id,
         ${ACCOUNT_OWNER_SQL} AS account_owner_staff_id
    FROM audit_events a
    JOIN documents d ON d.id = NULLIF(a.detail->>'documentId', '')::bigint
                    AND d.status IN ('issued', 'superseded')
    LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN document_templates t ON t.id = tv.template_id
    LEFT JOIN matters dm ON dm.id = d.matter_id
   WHERE a.target_type = 'payment' AND a.action = 'payment.create'
     AND a.target_id = ANY($1::bigint[])
     AND (a.detail->>'documentId') ~ '^[0-9]+$'
   ORDER BY a.target_id, a.id DESC`;

const LINES_SQL = `
  SELECT al.payment_id, al.amount, c.condition_no, c.name, c.tax_category, c.kind,
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
 *
 * 計算書は明細の作りが違う（検収書の delivery_line_items ではなく lineGroups）。
 * 読めていなかったので、前金・後金で2行出ている計算書から支払を立てても、
 * 経理提出用は合計の1行だけになっていた。紙と経理で行数が違うと、経理は
 * 何に対する支払か照合できない。
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
  // 計算書の明細。小計の括り（入金企業 × 言語の製品）1 つを 1 行にする。
  // 前金・後金は同じ製造回の 1 つの取引で、紙でも 1 つの小計にまとめてある。
  // 経理は紙の小計と帳票の行を突き合わせるので、行も小計に揃える。
  // 検収書の行があるときは触らない（1枚に両方は載らない）。
  if (!lines.length) {
    /** 組ごとの有償の個数（個数建てでない組は null）。寄せるときに足す。 */
    const counted = new Map<DocumentLine, number | null>();
    for (const group of rowsOf(values.lineGroups)) {
      const rows = rowsOf(group.lines);
      const amount = n(group.subtotalPayment)
        ?? rows.reduce((sum, row) => sum + (n(row.paymentJpy) ?? 0), 0);
      // 数量は個数建ての行だけが持つ。全部の行が持つときだけ足す（受領額 × 料率の行は 1）。
      // 単価は渡さない。経理側が 金額 ÷ 数量 で出し、割り切れないときは空にする。
      const counts = rows.map((row) => n(row.quantity));
      const billable = counts.length && counts.every((q) => q !== null && q > 0)
        ? counts.reduce((sum: number, q) => sum + (q ?? 0), 0) : null;
      const delivered = rows.map((row) => text(row.occurredOn).slice(0, 10)).filter(Boolean).sort();
      const content = statementGroupLabel(group, rows) || "（内容未設定）";
      // 同じ入金企業・言語の組は 1 組に寄せる（前金・後金を別の小計にしていた頃の計算書）。
      const same = lines.find((l) => l.content === content);
      if (same) {
        same.amount += amount;
        // 個数は寄せる両方が個数建てのときだけ足す。片方でも個数が無ければ 1。
        const before = counted.get(same) ?? null;
        const total = before !== null && billable !== null ? before + billable : null;
        counted.set(same, total);
        same.quantity = total ?? (same.amount > 0 ? 1 : null);
        same.deliveryDate = [same.deliveryDate, delivered.at(-1)].filter(Boolean).sort().at(-1) ?? null;
        continue;
      }
      const line: DocumentLine = {
        content,
        unitPrice: null,
        quantity: billable ?? (amount > 0 ? 1 : null),
        amount,
        deliveryDate: delivered.at(-1) ?? null
      };
      counted.set(line, billable);
      lines.push(line);
    }
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

/**
 * 計算書の小計の括りの名前：入金企業・言語（「Hachette・フランス語」）。
 *
 * 焼き付けた組が入金企業と言語を持っていればそれを使う。持っていない（前の版で
 * 決定した）計算書は、対象契約の先頭（入金企業）と製品名の括弧（言語・地域）から拾う。
 */
export function statementGroupLabel(group: Record<string, any>, rows: Array<Record<string, any>>): string {
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
  const [head, ...tail] = text(group.contractTitle).split("\u3000");
  const payer = text(group.payerName) || text(head);
  let language = text(group.languageLabel);
  if (!language) {
    // 製品名の括弧（「X（フランス語）」）→ 対象契約の入金企業の後ろ（「タイ語版」）。
    const product = text(rows[0]?.productName);
    const m = product.match(/（([^（）]+)）\s*$/);
    language = m ? m[1]!.trim() : text(group.payerName) ? "" : tail.join("　").trim();
  }
  // 製品名の括弧は言語と地域を並べている（「英語・中国・アメリカ合衆国…」）。
  // 支払内容に出すのは言語だけ。「◯◯語」が1つも無いときはそのまま出す。
  const parts = language.split("・").map((x) => x.trim()).filter(Boolean);
  const languages = parts.filter((x) => /語(版)?$/.test(x));
  if (languages.length) language = languages.join("・");
  const label = [payer, language].filter(Boolean).join("・");
  return label || text(rows[0]?.productName) || text(group.contractNumber);
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
      const docOf = new Map<number, NonNullable<AccountingSource["document"]>>();
      const docTitle = new Map<number, string>();
      const docOwner = new Map<number, number>();
      const accountOwner = new Map<number, number>();
      const take = (d: any) => {
        const paymentId = Number(d.payment_id);
        docOf.set(paymentId, {
          id: Number(d.document_id), number: str(d.document_no), templateKey: str(d.template_key)
        });
        const lines = documentLinesFrom(d.rendered_values);
        if (lines.length) docLines.set(paymentId, lines);
        const title = documentTitleFrom(d.rendered_values, str(d.template_key));
        if (title) docTitle.set(paymentId, title);
        if (d.owner_staff_id) docOwner.set(paymentId, Number(d.owner_staff_id));
        if (d.account_owner_staff_id) accountOwner.set(paymentId, Number(d.account_owner_staff_id));
      };
      if (ids.length) {
        const docs = await this.database.query(DOCUMENT_SQL, [ids]);
        const ambiguous = new Set<number>();
        for (const d of docs.rows as any[]) {
          if (Number(d.documents) !== 1) { ambiguous.add(Number(d.payment_id)); continue; }
          take(d);
        }
        // 実績から辿れなかった支払は、支払を立てたときの記録から書類を引く。
        // 複数の書類にまたがる支払（ambiguous）は決めない。
        const rest = ids.filter((id) => !docOf.has(id) && !ambiguous.has(id));
        if (rest.length) {
          const byAudit = await this.database.query(DOCUMENT_BY_AUDIT_SQL, [rest]);
          for (const d of byAudit.rows as any[]) take(d);
        }
      }
      // 案件の担当が無い支払は、書類の担当者で代える（計算書を台帳から出すと案件が無い）。
      const ownerIds = [...new Set([...docOwner.values(), ...accountOwner.values()])];
      const staffById = new Map<number, { name: string; department: string | null; email: string | null }>();
      if (ownerIds.length) {
        const staff = await this.database.query(
          "SELECT id, name, department, email FROM staff WHERE id = ANY($1::bigint[])", [ownerIds]);
        for (const s of staff.rows as any[]) {
          staffById.set(Number(s.id), { name: String(s.name ?? ""), department: str(s.department), email: str(s.email) });
        }
      }
      const kindsOf = new Map<number, string[]>();
      for (const l of lines.rows as any[]) {
        const id = Number(l.payment_id);
        kindsOf.set(id, [...(kindsOf.get(id) ?? []), String(l.kind ?? "")]);
      }

      const byPayment = new Map<number, AllocationLine[]>();
      for (const l of lines.rows as any[]) {
        const id = Number(l.payment_id);
        const list = byPayment.get(id) ?? [];
        list.push({
          conditionNo: str(l.condition_no),
          name: String(l.name ?? ""),
          taxCategory: (["taxable", "reduced", "exempt", "included"].includes(String(l.tax_category))
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
        // 社内の担当者（付け替えたもの）→ 案件の担当 → 書類の担当者。
        const assigned = staffById.get(accountOwner.get(id) ?? 0) ?? null;
        const docStaff = staffById.get(docOwner.get(id) ?? 0) ?? null;
        const ownerName = assigned?.name || str(r.owner_name) || docStaff?.name || null;
        const ownerDepartment = assigned ? assigned.department
          : str(r.owner_name) ? str(r.owner_department) : docStaff?.department ?? null;
        const ownerEmail = assigned ? assigned.email
          : str(r.owner_name) ? str(r.owner_email) : docStaff?.email ?? null;
        owners.set(id, ownerName ?? "(担当者未設定)");
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
            kana: str(r.account_holder_kana) ?? str(r.name_kana),
            kind: r.party_kind === "individual" ? "individual" : "corporate",
            invoiceNo: str(r.invoice_no), withholding: r.withholding === true,
            ...withholdingPartyOf(r)
          },
          ownerName,
          ownerDepartment,
          ownerEmail,
          matterNo: str(r.matter_no),
          matterTitle: str(r.matter_title),
          lines: byPayment.get(id) ?? [],
          documentLines: docLines.get(id),
          document: docOf.get(id) ?? null,
          documentTitle: docTitle.get(id) ?? null,
          conditionKinds: kindsOf.get(id) ?? []
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
