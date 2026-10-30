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

export interface WriteBackResult {
  schedules: Array<{ scheduleId: number; conditionId: number | null; from: string | null; to: string }>;
  payments: Array<{ paymentId: number; paymentNo: string | null; from: string | null; to: string }>;
  /** 支払済みで動かさなかった支払。 */
  paidKept: Array<{ paymentId: number; paymentNo: string | null; dueOn: string | null }>;
  contact: { partyId: number; action: "updated" | "added"; name: string | null } | null;
}

export const emptyWriteBack = (): WriteBackResult => ({ schedules: [], payments: [], paidKept: [], contact: null });

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

  if (result.schedules.length || result.payments.length || result.paidKept.length || result.contact) {
    await recordAudit(client, {
      actor: input.actor, action: "document.write_back", targetType: "document", targetId: input.documentId,
      detail: { ...result }
    });
  }
  return result;
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
