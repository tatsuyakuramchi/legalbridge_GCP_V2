import { dateStr, int, str, type Queryable } from "../core/db.js";
import { recordAudit } from "../core/audit.js";
import { splitContact } from "./contact-line.js";
import { deliveryLinesFrom, orderLinesFrom } from "./template-context.js";

/**
 * 文書で直した値を、決定のときに台帳へ書き戻す（docs/document-write-back.md）。
 *
 *   支払日 … 発注書の明細の行・検収書の行・頭書きの支払日（検収書・役務提供完了通知書・計算書）。
 *            その行の予定の回（condition_schedules.pay_on）を直し、その回の実績に割り当てた支払の
 *            予定日（payments.due_on）も動かす。支払済みの支払は動かさない（結果に残す）。
 *   通知先 … 相手方の担当者（部署・氏名・メール・電話）。取引先の主担当にする（同じ人がいれば直し、
 *            いなければ足す。主担当の印はその人に移す）。
 *
 * 「直した」は、条件から組み直した既定の値と違うこと。既定のままの行は書き戻さない（検収書の行の
 * 支払日は納品日からの既定で出るので、予定の支払日と違っても人が直したとは限らない）。
 * 決定と同じ取引の中で行い、何を変えたかを監査記録と決定の結果に残す。
 */

type Row = Record<string, any>;
type Ctx = Record<string, any>;

const ORDER_TEMPLATES = new Set(["purchase_order", "intl_purchase_order"]);
/** 頭書きの支払日として人が直せる欄の名前。 */
const HEADER_PAY_KEYS = ["PAYMENT_DATE", "paymentDueDate", "支払期日", "sc_payment_date"];
const isoDay = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

export interface PayOnChange {
  /** 直す予定の回。予定の無い実績（納品の都度など）は null で、支払の予定日だけ動かす。 */
  scheduleId: number | null;
  conditionId: number | null;
  /** その回の実績（支払の予定日を動かす相手）。 */
  eventIds: number[];
  from: string | null;
  to: string;
  /** どの欄で直したか（明細の行・頭書き）。 */
  source: "line" | "header";
}

/**
 * 文書で直した支払日（純粋関数）。manual は人が入れた値、context は条件から組んだ文脈。
 * 明細の行で直したものが先、頭書きは行で触っていない実績に効く。
 */
export function payOnChanges(templateKey: string, manual: Row, context: Ctx): PayOnChange[] {
  const schedules = ((context.schedules ?? []) as Ctx[]);
  const events = ((context.events ?? []) as Ctx[]);
  const scheduleOf = (id: unknown) => schedules.find((s) => Number(s.id) === Number(id)) ?? null;
  const out: PayOnChange[] = [];
  const touchedEvents = new Set<number>();
  const push = (c: PayOnChange) => {
    const same = out.find((x) => (c.scheduleId !== null && x.scheduleId === c.scheduleId)
      || (c.scheduleId === null && x.scheduleId === null && x.eventIds.join(",") === c.eventIds.join(",")));
    if (same) { same.to = c.to; same.eventIds = [...new Set([...same.eventIds, ...c.eventIds])]; return; }
    out.push(c);
  };

  if (ORDER_TEMPLATES.has(templateKey)) {
    const rows = Array.isArray(manual.items) ? manual.items as Row[] : [];
    const defaults = orderLinesFrom(context);
    for (const row of rows) {
      const to = isoDay(row.payment_date);
      if (!to || row.folded) continue;
      // 行が回を持っていなければ（この仕組みより前に保存した下書き）、条件の回が 1 つだけのときその回。
      const own = schedules.filter((s) => Number(s.conditionId) === Number(row.condition_id));
      const sid = int(row.schedule_id) ?? (own.length === 1 ? int(own[0].id) : null);
      const schedule = sid ? scheduleOf(sid) : null;
      if (!schedule) continue;
      const def = defaults.find((d) => Number(d.schedule_id) === Number(sid));
      const before = dateStr(schedule.payOn);
      if (to === before || (def && isoDay(def.payment_date) === to)) continue;
      push({ scheduleId: Number(sid), conditionId: int(schedule.conditionId), eventIds: [], from: before, to, source: "line" });
    }
    return out;
  }

  const rows = Array.isArray(manual.delivery_line_items) ? manual.delivery_line_items as Row[] : [];
  if (rows.length) {
    const defaults = deliveryLinesFrom(context);
    for (const row of rows) {
      const to = isoDay(row.payment_date);
      const eventId = int(row.event_id);
      if (!to || !eventId) continue;
      const def = defaults.find((d) => Number(d.event_id) === eventId);
      if (def && isoDay(def.payment_date) === to) continue;
      const event = events.find((e) => Number(e.id) === eventId);
      if (!event) continue;
      touchedEvents.add(eventId);
      const sid = int(event.schedule?.id);
      push({ scheduleId: sid, conditionId: int(event.conditionId), eventIds: [eventId],
             from: dateStr(event.schedule?.payOn) ?? isoDay(def?.payment_date), to, source: "line" });
    }
  }

  // 頭書きの支払日。人が入れていて、行で直していない実績の回と違うものに効かせる。
  const header = HEADER_PAY_KEYS.map((k) => isoDay(manual[k])).find(Boolean) ?? null;
  if (header) {
    for (const event of events) {
      const eventId = Number(event.id);
      if (touchedEvents.has(eventId)) continue;
      const sid = int(event.schedule?.id);
      const before = dateStr(event.schedule?.payOn);
      if (sid && before === header) continue;
      push({ scheduleId: sid, conditionId: int(event.conditionId), eventIds: [eventId], from: before, to: header, source: "header" });
    }
  }
  return out;
}

export interface ContactValue { department: string | null; name: string | null; email: string | null; phone: string | null }

const NAME_KEYS = ["NOTICE_CONTACT_NAME", "通知先担当者", "VENDOR_CONTACT_NAME", "先方担当者名"];
const EMAIL_KEYS = ["NOTICE_CONTACT_EMAIL", "通知先メール", "VENDOR_CONTACT_EMAIL", "先方担当者メール"];
const PHONE_KEYS = ["NOTICE_CONTACT_PHONE", "通知先電話", "VENDOR_CONTACT_PHONE"];
const DEPT_KEYS = ["NOTICE_CONTACT_DEPARTMENT", "VENDOR_CONTACT_DEPARTMENT", "先方担当者部署"];
/** 許諾者（甲）の欄。IN の文書（相手方が許諾者）のときだけ相手方の通知先として読む。 */
const LICENSOR_NAME = "Licensor_担当者", LICENSOR_EMAIL = "Licensor_メール", LICENSOR_PHONE = "Licensor_電話";
const LICENSOR_LINES = ["licensorContact", "許諾者連絡先"];

/**
 * 文書に入っている相手方の通知先（純粋関数）。values は決定で焼き付ける値。licensorIsCounterparty は
 * 許諾者の欄が相手方か（IN の文書）。何も入っていなければ null。
 */
export function noticeContactOf(values: Row, licensorIsCounterparty: boolean): ContactValue | null {
  const pick = (keys: string[]) => keys.map((k) => str(values[k])).find(Boolean) ?? null;
  let v: ContactValue = { department: pick(DEPT_KEYS), name: pick(NAME_KEYS), email: pick(EMAIL_KEYS), phone: pick(PHONE_KEYS) };
  if (licensorIsCounterparty) {
    const line = LICENSOR_LINES.map((k) => str(values[k])).find(Boolean);
    const parts = line ? splitContact(line) : null;
    v = {
      department: v.department ?? (parts?.department || null),
      name: v.name ?? str(values[LICENSOR_NAME]) ?? (parts?.name || null),
      email: v.email ?? str(values[LICENSOR_EMAIL]) ?? (parts?.email || null),
      phone: v.phone ?? str(values[LICENSOR_PHONE]) ?? (parts?.phone || null)
    };
  }
  return v.name || v.email ? v : null;
}

const norm = (v: unknown) => String(v ?? "").replace(/[\s　]/g, "").toLowerCase();

export interface StoredContact { id: number; name: string | null; email: string | null; phone: string | null; department: string | null; roles: string[] }

/**
 * 取引先の担当者に対してすること（純粋関数）。同じ人（氏名、氏名が無ければメール）がいれば、入っている
 * 値で違うところを直して主担当にする。いなければ主担当として足す。主担当がすでに同じ値なら何もしない。
 */
export function contactPlan(contacts: StoredContact[], v: ContactValue):
  { kind: "none" } | { kind: "update"; id: number; set: Partial<ContactValue>; makePrimary: boolean } | { kind: "insert" } {
  const same = contacts.find((c) => v.name ? norm(c.name) === norm(v.name) : norm(c.email) === norm(v.email));
  if (!same) return { kind: "insert" };
  const set: Partial<ContactValue> = {};
  // 空白・大文字小文字だけの違いは直さない（「山田　花子」と「山田 花子」は同じ人の同じ名前）。
  for (const k of ["department", "name", "email", "phone"] as const) {
    if (v[k] && norm(same[k]) !== norm(v[k])) set[k] = v[k];
  }
  const makePrimary = !same.roles.includes("primary");
  return Object.keys(set).length || makePrimary ? { kind: "update", id: same.id, set, makePrimary } : { kind: "none" };
}

/** 発注書の行で直した金額・納期・業務期間の書き戻し先。 */
export type FieldName = "planned_amount" | "due_on" | "service_from" | "service_to"
  | "flat_amount" | "unit_amount" | "quantity" | "delivery_due" | "term_start" | "term_end";
export const FIELD_LABEL: Record<FieldName, string> = {
  planned_amount: "予定額", due_on: "納期（予定の回）", service_from: "業務期間の開始（予定の回）", service_to: "業務期間の終了（予定の回）",
  flat_amount: "金額", unit_amount: "単価", quantity: "数量", delivery_due: "納期", term_start: "業務期間の開始", term_end: "業務期間の終了"
};
const MONEY_FIELDS = new Set<FieldName>(["planned_amount", "flat_amount", "unit_amount", "quantity"]);
export interface FieldChange {
  /** 予定の回（condition_schedules）か、条件そのもの（conditions）か。 */
  target: "schedule" | "condition";
  id: number; conditionId: number; field: FieldName;
  from: string | number | null; to: string | number;
}

const numOf = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,，¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * 発注書の行で直した金額・納期・業務期間（純粋関数）。既定（条件から組んだ行）と違うものだけ。
 *   予定の回の行 … 金額 → 予定額、納品日 → 納期、業務期間 → その回の役務提供期間
 *   回の無い条件の行 … 金額・単価・数量 → 条件の定額・単価・数量、納品日 → 納期、業務期間 → 条件の期間
 * 金額は円の条件だけ（外貨は紙の額と台帳の最小単位がずれるので書き戻さない）。まとめた行は書き戻さない。
 */
export function orderFieldChanges(templateKey: string, manual: Row, context: Ctx): FieldChange[] {
  if (!ORDER_TEMPLATES.has(templateKey)) return [];
  const rows = Array.isArray(manual.items) ? manual.items as Row[] : [];
  if (!rows.length) return [];
  const defaults = orderLinesFrom(context);
  const conditions = ((context.conditions ?? []) as Ctx[]);
  const schedules = ((context.schedules ?? []) as Ctx[]);
  const out: FieldChange[] = [];
  const day = (v: unknown) => isoDay(v);
  for (const row of rows) {
    if (row.folded) continue;
    const conditionId = int(row.condition_id);
    if (!conditionId) continue;
    const condition = conditions.find((c) => Number(c.id) === conditionId);
    const yen = String(condition?.currency ?? "JPY") === "JPY";
    const sid = int(row.schedule_id);
    if (sid) {
      const def = defaults.find((d) => Number(d.schedule_id) === sid);
      if (!def) continue;
      const pairs: Array<[FieldName, unknown, unknown, "money" | "day"]> = [
        ["planned_amount", row.amount_ex_tax, def.amount_ex_tax, "money"],
        ["due_on", row.delivery_date, def.delivery_date, "day"],
        ["service_from", row.term_start, def.term_start, "day"],
        ["service_to", row.term_end, def.term_end, "day"]
      ];
      for (const [field, now, was, kind] of pairs) {
        const to = kind === "money" ? numOf(now) : day(now);
        const from = kind === "money" ? numOf(was) : day(was);
        if (to === null || to === from || (kind === "money" && !yen)) continue;
        out.push({ target: "schedule", id: sid, conditionId, field, from, to });
      }
      continue;
    }
    // 回の無い条件の行。条件に予定の回があれば、どの回か決められないので触らない。
    if (schedules.some((x) => Number(x.conditionId) === conditionId)) continue;
    const def = defaults.find((d) => Number(d.condition_id) === conditionId && !d.schedule_id);
    if (!def) continue;
    const pairs: Array<[FieldName, unknown, unknown, "money" | "day"]> = [
      ["unit_amount", row.unit_price, def.unit_price, "money"],
      ["quantity", row.quantity, def.quantity, "money"],
      ["flat_amount", row.amount_ex_tax, def.amount_ex_tax, "money"],
      ["delivery_due", row.delivery_date, def.delivery_date, "day"],
      ["term_start", row.term_start, def.term_start, "day"],
      ["term_end", row.term_end, def.term_end, "day"]
    ];
    for (const [field, now, was, kind] of pairs) {
      const to = kind === "money" ? numOf(now) : day(now);
      const from = kind === "money" ? numOf(was) : day(was);
      if (to === null || to === from || (kind === "money" && !yen)) continue;
      out.push({ target: "condition", id: conditionId, conditionId, field, from, to });
    }
  }
  return out;
}

export interface WriteBackResult {
  /** 金額・納期・業務期間で反映したもの。 */
  fields?: Array<FieldChange & { label: string }>;
  /** 反映しなかったもの（実績・支払がある、など）とその理由。 */
  skipped?: Array<{ conditionId: number; label: string; reason: string }>;
  schedules: Array<{ scheduleId: number; conditionId: number | null; from: string | null; to: string }>;
  payments: Array<{ paymentId: number; paymentNo: string | null; from: string | null; to: string }>;
  /** 支払済みで動かさなかった支払。 */
  paidKept: Array<{ paymentId: number; paymentNo: string | null; dueOn: string | null }>;
  contact: { partyId: number; action: "updated" | "added"; name: string | null } | null;
}

export const emptyWriteBack = (): WriteBackResult => ({ fields: [], skipped: [], schedules: [], payments: [], paidKept: [], contact: null });

/** 決定の取引の中で書き戻す。 */
export async function applyWriteBack(client: Queryable, input: {
  documentId: number; documentNo: string; templateKey: string;
  manual: Row; context: Ctx; values: Row; conditionIds: number[];
  agreementId: number | null; actor: string;
}): Promise<WriteBackResult> {
  const result = emptyWriteBack();
  const why = `文書 ${input.documentNo} で直した値を反映`;

  // ---- 支払日 ----
  for (const change of payOnChanges(input.templateKey, input.manual, input.context)) {
    let eventIds = change.eventIds;
    if (change.scheduleId) {
      const r = await client.query(
        `UPDATE condition_schedules SET pay_on = $2::date
          WHERE id = $1 AND pay_on IS DISTINCT FROM $2::date
          RETURNING condition_id`, [change.scheduleId, change.to]);
      const hit = r.rows[0] as { condition_id: number } | undefined;
      if (hit) {
        result.schedules.push({ scheduleId: change.scheduleId, conditionId: Number(hit.condition_id), from: change.from, to: change.to });
        await recordAudit(client, {
          actor: input.actor, action: "condition.schedule_pay_on", targetType: "condition", targetId: Number(hit.condition_id),
          detail: { scheduleId: change.scheduleId, from: change.from, to: change.to, documentId: input.documentId, reason: why }
        });
      }
      // その回の実績すべての支払を動かす。
      const evs = await client.query(
        "SELECT id FROM condition_events WHERE schedule_id = $1 AND status = 'active'", [change.scheduleId]);
      eventIds = [...new Set([...eventIds, ...(evs.rows as Array<{ id: number }>).map((e) => Number(e.id))])];
    }
    if (!eventIds.length) continue;
    const pays = await client.query(
      `SELECT DISTINCT p.id, p.payment_no, p.status, p.due_on
         FROM payments p JOIN payment_allocations al ON al.payment_id = p.id
        WHERE al.event_id = ANY($1::bigint[]) AND p.status <> 'canceled'`, [eventIds]);
    for (const p of pays.rows as Array<Record<string, any>>) {
      const from = dateStr(p.due_on);
      if (p.status === "paid") {
        if (!result.paidKept.some((x) => x.paymentId === Number(p.id))) {
          result.paidKept.push({ paymentId: Number(p.id), paymentNo: str(p.payment_no), dueOn: from });
        }
        continue;
      }
      if (from === change.to) continue;
      await client.query("UPDATE payments SET due_on = $2::date, updated_at = now() WHERE id = $1", [p.id, change.to]);
      result.payments.push({ paymentId: Number(p.id), paymentNo: str(p.payment_no), from, to: change.to });
      await recordAudit(client, {
        actor: input.actor, action: "payment.due_on", targetType: "payment", targetId: Number(p.id),
        detail: { from, to: change.to, documentId: input.documentId, reason: why }
      });
    }
  }

  // ---- 金額・納期・業務期間（発注書の行）----
  for (const change of orderFieldChanges(input.templateKey, input.manual, input.context)) {
    const label = FIELD_LABEL[change.field];
    const money = MONEY_FIELDS.has(change.field);
    if (change.target === "schedule") {
      // 実績の付いた回の予定額は動かさない（実績の額が別にあり、検収の「予定と違う額」で扱う）。
      if (money) {
        const ev = await client.query(
          "SELECT 1 FROM condition_events WHERE schedule_id = $1 AND status = 'active' LIMIT 1", [change.id]);
        if (ev.rows[0]) { result.skipped!.push({ conditionId: change.conditionId, label, reason: "実績の付いた回の予定額は動かしません" }); continue; }
      }
      const r = await guarded(client, () => client.query(
        `UPDATE condition_schedules SET ${change.field} = $2 WHERE id = $1 AND ${change.field} IS DISTINCT FROM $2 RETURNING id`,
        [change.id, change.to]));
      if (r === "failed") { result.skipped!.push({ conditionId: change.conditionId, label, reason: "条件明細の決まり（期間の前後など）に合わないので反映していません" }); continue; }
      if (!r.rows[0]) continue;
    } else {
      const c = (await client.query(
        `SELECT c.kind, c.status, COALESCE(c.series_id, c.id) AS series,
                EXISTS (SELECT 1 FROM condition_events e JOIN conditions x ON x.id = e.condition_id
                         WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id) AND e.status = 'active') AS has_events,
                EXISTS (SELECT 1 FROM payment_allocations al JOIN payments p ON p.id = al.payment_id
                          JOIN conditions x ON x.id = al.condition_id
                         WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id) AND p.status <> 'canceled') AS has_payments
           FROM conditions c WHERE c.id = $1`, [change.id])).rows[0] as Record<string, any> | undefined;
      if (!c || !["active", "draft"].includes(String(c.status))) continue;
      // 許諾の条件の期間は許諾期間（契約の中身）。文書の行からは動かさない。
      if (!money && String(c.kind) === "license") {
        result.skipped!.push({ conditionId: change.conditionId, label, reason: "許諾の条件の期間は条件明細で直してください" }); continue;
      }
      // 実績・支払のある条件の金額は、直接直すと過去の回の額まで変わる。改訂（版を分ける）で直す。
      if (money && (c.has_events || c.has_payments)) {
        result.skipped!.push({ conditionId: change.conditionId, label, reason: "実績・支払がある条件の金額は、条件明細で改訂してください" }); continue;
      }
      const r = await guarded(client, () => client.query(
        `UPDATE conditions SET ${change.field} = $2, updated_at = now() WHERE id = $1 AND ${change.field} IS DISTINCT FROM $2 RETURNING id`,
        [change.id, change.to]));
      if (r === "failed") { result.skipped!.push({ conditionId: change.conditionId, label, reason: "条件明細の決まり（期間の前後など）に合わないので反映していません" }); continue; }
      if (!r.rows[0]) continue;
    }
    result.fields!.push({ ...change, label });
    await recordAudit(client, {
      actor: input.actor, action: change.target === "schedule" ? "condition.schedule_field" : "condition.field",
      targetType: "condition", targetId: change.conditionId,
      detail: { field: change.field, ...(change.target === "schedule" ? { scheduleId: change.id } : {}),
                from: change.from, to: change.to, documentId: input.documentId, reason: why }
    });
  }

  // ---- 通知先 ----
  const party = await counterpartyOf(client, input);
  if (party) {
    const contact = noticeContactOf(input.values, party.licensorIsCounterparty);
    if (contact) {
      const rows = (await client.query(
        `SELECT id, name, email, phone, department, COALESCE(roles, ARRAY[role]::text[]) AS roles
           FROM party_contacts WHERE party_id = $1 ORDER BY id`, [party.id])).rows as Array<Record<string, any>>;
      const stored: StoredContact[] = rows.map((c) => ({
        id: Number(c.id), name: str(c.name), email: str(c.email), phone: str(c.phone), department: str(c.department),
        roles: (Array.isArray(c.roles) ? c.roles : []).filter(Boolean).map(String)
      }));
      const plan = contactPlan(stored, contact);
      if (plan.kind !== "none") {
        let contactId: number;
        if (plan.kind === "insert") {
          const r = await client.query(
            `INSERT INTO party_contacts (party_id, role, roles, name, email, phone, department)
             VALUES ($1, 'primary', ARRAY['primary']::text[], $2, $3, $4, $5) RETURNING id`,
            [party.id, contact.name, contact.email, contact.phone, contact.department]);
          contactId = Number((r.rows[0] as { id: number }).id);
        } else {
          contactId = plan.id;
          const sets: string[] = []; const params: unknown[] = [contactId];
          for (const [k, v] of Object.entries(plan.set)) { params.push(v); sets.push(`${k} = $${params.length}`); }
          if (plan.makePrimary) {
            sets.push("roles = array_prepend('primary', array_remove(COALESCE(roles, ARRAY[]::text[]), 'primary'))", "role = 'primary'");
          }
          await client.query(`UPDATE party_contacts SET ${sets.join(", ")} WHERE id = $1`, params);
        }
        // 主担当の印は 1 人だけ。ほかの人から外す（その人の他の印は残す）。
        await client.query(
          `UPDATE party_contacts
              SET roles = array_remove(roles, 'primary'),
                  role = CASE WHEN role = 'primary' THEN (array_remove(roles, 'primary'))[1] ELSE role END
            WHERE party_id = $1 AND id <> $2 AND 'primary' = ANY(roles)`, [party.id, contactId]);
        result.contact = { partyId: party.id, action: plan.kind === "insert" ? "added" : "updated", name: contact.name };
        await recordAudit(client, {
          actor: input.actor, action: plan.kind === "insert" ? "party.add_contact" : "party.update_contact",
          targetType: "party", targetId: party.id,
          detail: { contactId, roles: ["primary"], fields: plan.kind === "insert" ? ["name", "email", "phone", "department"] : Object.keys(plan.set),
                    documentId: input.documentId, reason: why }
        });
      }
    }
  }

  if (result.schedules.length || result.payments.length || result.paidKept.length || result.contact
      || result.fields!.length || result.skipped!.length) {
    await recordAudit(client, {
      actor: input.actor, action: "document.write_back", targetType: "document", targetId: input.documentId,
      detail: { ...result }
    });
  }
  return result;
}

/**
 * 1 つの書き戻しを、決定の取引を壊さずに試す（失敗したらその書き戻しだけ戻す）。
 * 期間の前後などの制約に当たっても、文書の決定は止めない。
 */
async function guarded<T>(client: Queryable, run: () => Promise<T>): Promise<T | "failed"> {
  await client.query("SAVEPOINT write_back");
  try {
    const out = await run();
    await client.query("RELEASE SAVEPOINT write_back");
    return out;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT write_back");
    return "failed";
  }
}

/**
 * 文書の相手方。受取人（共著の取り分）→ 載せた条件の相手先 → 合意の相手先 の順。
 * 許諾者の欄が相手方か（IN の文書）も返す。
 */
async function counterpartyOf(client: Queryable, input: { manual: Row; conditionIds: number[]; agreementId: number | null }):
  Promise<{ id: number; licensorIsCounterparty: boolean } | null> {
  const payee = int(input.manual._payeePartyId);
  const cond = input.conditionIds.length ? (await client.query(
    "SELECT counterparty_id, direction FROM conditions WHERE id = ANY($1::bigint[]) ORDER BY array_position($1::bigint[], id) LIMIT 1",
    [input.conditionIds])).rows[0] as { counterparty_id: number | null; direction: string } | undefined : undefined;
  const agreement = input.agreementId ? (await client.query(
    "SELECT counterparty_id, direction FROM agreements WHERE id = $1", [input.agreementId])).rows[0] as
      { counterparty_id: number | null; direction: string | null } | undefined : undefined;
  const id = payee ?? int(cond?.counterparty_id) ?? int(agreement?.counterparty_id);
  if (!id) return null;
  const direction = cond?.direction ?? agreement?.direction ?? "in";
  return { id, licensorIsCounterparty: direction !== "out" };
}
