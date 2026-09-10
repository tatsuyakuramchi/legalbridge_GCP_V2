import { inTransaction, type Transactable } from "../core/db.js";
import { dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { claimSchedule } from "./schedule-service.js";

/**
 * 条件の実績（明細の数値）。
 *
 * これまで condition_events を書けるのは計算書の作成だけだった。製造数も
 * 検収も納品も、画面から記録できず、間違って入った数値を直す手段も無かった。
 *
 * 記録は消さない。取り消しは status を void にして残す。実績は「何がいくつ
 * あったか」の記録なので、消すと後から突き合わせられなくなる。
 *
 * 計算書から作られた実績（document_id を持つもの）はここでは触らない。
 * 触ると計算書の中身と実績が食い違う。直すなら計算書ごと差し替える。
 */

export type EventType =
  | "manufacturing" | "sales" | "sublicense_receipt"
  | "inspection" | "delivery" | "service_period" | "adjustment";

export const EVENT_TYPES: Array<{ value: EventType; label: string }> = [
  { value: "manufacturing", label: "製造" },
  { value: "sales", label: "売上" },
  { value: "sublicense_receipt", label: "再許諾の受領" },
  { value: "inspection", label: "検収" },
  { value: "delivery", label: "納品" },
  { value: "service_period", label: "役務の期間" },
  { value: "adjustment", label: "調整" }
];

export interface EventInput {
  eventType: EventType;
  occurredOn: string;
  period?: string | null;
  quantity?: number | null;
  sampleQuantity?: number | null;
  grossAmount?: number | null;
  deductions?: number | null;
  amount: number;
  note?: string | null;
  /** どの予定の回か。分納の支払日は予定から引くので、ここが繋がっていないと空になる。 */
  scheduleId?: number | null;
  /** 検収書がそのまま使う項目。ここに入れておけば文書を作るとき人が入れずに済む。 */
  deliverable?: string | null;
  inspectedOn?: string | null;
  inspectorDept?: string | null;
  inspectorName?: string | null;
}

export interface EventRow {
  id: number;
  eventType: string;
  occurredOn: string | null;
  period: string | null;
  quantity: number | null;
  sampleQuantity: number | null;
  grossAmount: number | null;
  deductions: number;
  amount: number;
  status: string;
  note: string | null;
  scheduleId: number | null;
  /** 予定の回の呼び名（第1回・2026年4月分など）。画面で回を見分ける。 */
  scheduleLabel: string | null;
  deliverable: string | null;
  inspectedOn: string | null;
  inspectorDept: string | null;
  inspectorName: string | null;
  /** 計算書から作られた実績。画面からは直せない。 */
  documentId: number | null;
  documentNo: string | null;
  createdAt: string;
  createdBy: string;
}

export class ConditionEventService {
  constructor(private readonly database: Transactable) {}

  async list(conditionId: number): Promise<EventRow[]> {
    try {
      const r = await this.database.query(
        `SELECT e.id, e.event_type, e.occurred_on, e.period, e.quantity, e.sample_quantity,
                e.gross_amount, e.deductions, e.amount, e.status, e.note,
                e.schedule_id, s.label AS schedule_label, s.seq AS schedule_seq,
                e.deliverable, e.inspected_on, e.inspector_dept, e.inspector_name,
                e.document_id, d.document_no, e.created_at, e.created_by
           FROM condition_events e
           LEFT JOIN documents d ON d.id = e.document_id
           LEFT JOIN condition_schedules s ON s.id = e.schedule_id
          WHERE e.condition_id = $1
          ORDER BY e.occurred_on DESC, e.id DESC`, [conditionId]);
      return (r.rows as any[]).map((row) => ({
        id: Number(row.id),
        eventType: String(row.event_type),
        occurredOn: dateStr(row.occurred_on),
        period: str(row.period),
        quantity: num(row.quantity),
        sampleQuantity: num(row.sample_quantity),
        grossAmount: int(row.gross_amount),
        deductions: Number(row.deductions ?? 0),
        amount: Number(row.amount ?? 0),
        status: String(row.status),
        note: str(row.note),
        scheduleId: int(row.schedule_id),
        scheduleLabel: str(row.schedule_label)
          ?? (row.schedule_seq ? `第${Number(row.schedule_seq)}回` : null),
        deliverable: str(row.deliverable),
        inspectedOn: dateStr(row.inspected_on),
        inspectorDept: str(row.inspector_dept),
        inspectorName: str(row.inspector_name),
        documentId: int(row.document_id),
        documentNo: str(row.document_no),
        createdAt: new Date(String(row.created_at)).toISOString(),
        createdBy: String(row.created_by)
      }));
    } catch (error) { throw translate(error); }
  }

  async add(conditionId: number, input: EventInput, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, status FROM conditions WHERE id = $1", [conditionId]);
        const condition = head.rows[0] as { id: number; status: string } | undefined;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
        if (condition.status !== "active" && condition.status !== "draft") {
          // 差し替え済み・無効の版に実績を足すと、どの版の実績か分からなくなる。
          // 適用待ちの版はまだ効いていないので、実績はいまの版に付ける。
          throw new DomainError("CONFLICT",
            condition.status === "superseded"
              ? "旧版には実績を足せません。最新版に記録してください"
              : condition.status === "scheduled"
              ? "この版はまだ適用前です。実績はいま有効な版に記録してください"
              : "無効にした条件には実績を足せません");
        }

        // 回を選んでいれば、規則も既定値も予定側に合わせる。
        // 予定の行から作った実績と、ここから作った実績を同じものにする。
        let scheduleId: number | null = null;
        let occurredOn = input.occurredOn;
        let period = str(input.period);
        if (input.scheduleId) {
          const line = await claimSchedule(client, conditionId, input.scheduleId);
          scheduleId = input.scheduleId;
          occurredOn = occurredOn || (dateStr(line.due_on) ?? occurredOn);
          // 予定の名前を実績の期間に写す。「2026年4月分」がそのまま計算書に出る。
          period = period ?? str(line.label);
        }

        const amount = Math.round(input.amount);
        const gross = input.grossAmount === null || input.grossAmount === undefined
          ? null : Math.round(input.grossAmount);
        const deductions = Math.round(input.deductions ?? 0);
        if (gross !== null && gross - deductions !== amount) {
          // 総額・控除・実額が合わない記録を残すと、あとで検算できない。
          throw new DomainError("VALIDATION",
            `総額 ${gross} − 控除 ${deductions} = ${gross - deductions} が実額 ${amount} と合いません`);
        }

        const inserted = await client.query(
          `INSERT INTO condition_events
             (condition_id, schedule_id, event_type, occurred_on, period,
              quantity, sample_quantity, gross_amount, deductions, amount, note, created_by,
              deliverable, inspected_on, inspector_dept, inspector_name)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14::date, $15, $16)
           RETURNING id`,
          [conditionId, scheduleId, input.eventType, occurredOn, period,
           input.quantity ?? null, input.sampleQuantity ?? null,
           gross, deductions, amount, str(input.note), actor,
           str(input.deliverable), str(input.inspectedOn),
           str(input.inspectorDept), str(input.inspectorName)]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "condition.event_add", targetType: "condition", targetId: conditionId,
          detail: { eventId: id, eventType: input.eventType, occurredOn, amount, scheduleId }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /** 取り消し。行は残す。理由を必ず添える。 */
  async void(conditionId: number, eventId: number, reason: string, actor: string) {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "取り消しの理由は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const found = await client.query(
          `SELECT e.id, e.status, e.amount, e.document_id, d.document_no
             FROM condition_events e
             LEFT JOIN documents d ON d.id = e.document_id
            WHERE e.id = $1 AND e.condition_id = $2`, [eventId, conditionId]);
        const row = found.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `実績 ${eventId} が見つかりません`);
        if (row.status === "void") {
          throw new DomainError("CONFLICT", "すでに取り消されています");
        }
        if (row.document_id) {
          // 計算書の金額はこの実績から出ている。片方だけ消すと食い違う。
          throw new DomainError("CONFLICT",
            `この実績は計算書 ${row.document_no ?? `#${row.document_id}`} から作られています。` +
            "取り消すなら計算書ごと無効にしてください");
        }

        await client.query(
          "UPDATE condition_events SET status = 'void', note = $2 WHERE id = $1",
          [eventId, `取消：${why}`]);
        await recordAudit(client, {
          actor, action: "condition.event_void", targetType: "condition", targetId: conditionId,
          detail: { eventId, amount: Number(row.amount), reason: why }
        });
        return { voided: eventId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 結びつけられるかだけ確かめる。書かない。
   *
   * 文書を発行してから紐づけに失敗すると、番号の振られた文書だけが残り、
   * 人は同じものをもう一度作ることになる。発行の前に弾く。
   *
   * heldBy を渡すと、その文書が持っている実績は「空いている」ものとして扱う。
   * 訂正版は前の版から実績を引き取るので、ここを塞ぐと差し替えのたびに
   * 元の文書を無効にする手間が要る（それが二重作業の原因だった）。
   */
  async assertLinkable(
    conditionId: number, eventIds: number[], heldBy?: number | null
  ): Promise<void> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) return;
    const rows = await this.database.query(
      `SELECT id, status, document_id FROM condition_events
        WHERE id = ANY($1::bigint[]) AND condition_id = $2`, [ids, conditionId]);
    const found = rows.rows as Array<{ id: number; status: string; document_id: number | null }>;
    if (found.length !== ids.length) {
      throw new DomainError("NOT_FOUND", "この条件に無い実績が混ざっています");
    }
    const voided = found.filter((r) => r.status !== "active");
    if (voided.length) {
      throw new DomainError("CONFLICT",
        `取り消し済みの実績は結びつけられません（#${voided.map((r) => r.id).join("・")}）`);
    }
    const taken = found.filter((r) =>
      r.document_id !== null && (!heldBy || Number(r.document_id) !== Number(heldBy)));
    if (taken.length) {
      throw new DomainError("CONFLICT",
        `すでに別の文書に結びついている実績があります（#${taken.map((r) => r.id).join("・")}）。` +
        "その文書を訂正するか、無効にしてから結び直してください");
    }
  }

  /**
   * 結びつけを外す。
   *
   * 移行してきた文書を実績に結び直す作業では必ず取り違える。外せないと、
   * 間違えた瞬間にその実績は二度と正しい文書に結べなくなる（別の文書に
   * 取られている扱いになる）。直せる道を用意しておく。
   *
   * 外しても文書は変わらない。発行した紙の内容ではなく、
   * 「どの実績を指しているか」の索引を直すだけ。
   */
  async unlinkDocument(
    conditionId: number, eventIds: number[], documentId: number, actor: string
  ): Promise<{ unlinked: number }> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "外す実績がありません");
    try {
      return await inTransaction(this.database, async (client) => {
        // いま見ている文書に結びついているものだけ外す。番号を取り違えたまま
        // 押しても、別の文書の紐づけには手が届かない。
        const updated = await client.query(
          `UPDATE condition_events SET document_id = NULL
            WHERE id = ANY($1::bigint[]) AND condition_id = $2 AND document_id = $3`,
          [ids, conditionId, documentId]);
        const unlinked = updated.rowCount ?? 0;
        if (!unlinked) {
          throw new DomainError("CONFLICT",
            "その文書に結びついている実績がありません。画面を読み直してください");
        }
        await recordAudit(client, {
          actor, action: "condition.unlink_document", targetType: "condition",
          targetId: conditionId, detail: { documentId, eventIds: ids, unlinked }
        });
        return { unlinked };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 実績を条件ごとに分ける。1枚の検収書に、委託料と実費のように条件をまたいだ
   * 実績を載せるときの入口。結びつけは条件ごとに行うので、先に束を分ける。
   * 見つからない実績があれば止める（黙って落とすと、その回だけ検収書に載らない）。
   */
  async groupByCondition(eventIds: number[]): Promise<Map<number, number[]>> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(Number(n))))].filter((n) => n > 0);
    const out = new Map<number, number[]>();
    if (!ids.length) return out;
    const r = await this.database.query(
      "SELECT id, condition_id FROM condition_events WHERE id = ANY($1::bigint[])", [ids]);
    const rows = r.rows as Array<{ id: number; condition_id: number }>;
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((x) => Number(x.id)));
      throw new DomainError("NOT_FOUND",
        `実績が見つかりません：${ids.filter((i) => !known.has(i)).join(", ")}`);
    }
    for (const row of rows) {
      const cid = Number(row.condition_id);
      out.set(cid, [...(out.get(cid) ?? []), Number(row.id)]);
    }
    return out;
  }

  /**
   * 実績を発行済み文書に結びつける。検収書・計算書がどの実績から出たかは
   * この列（condition_events.document_id）にしか無く、書く処理が無かったため
   * 「この検収書は何回目の分か」が追えなかった。
   *
   * 文書は発行済みのものだけを受ける。下書きに結ぶと、下書きを捨てたときに
   * 実績だけが宙に浮く。
   */
  async linkDocument(
    conditionId: number, eventIds: number[], documentId: number, actor: string
  ): Promise<{ linked: number; documentNo: string | null }> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "結びつける実績がありません");
    try {
      return await inTransaction(this.database, async (client) => {
        const doc = await client.query(
          "SELECT id, document_no, status FROM documents WHERE id = $1", [documentId]);
        const document = doc.rows[0] as
          { document_no: string | null; status: string } | undefined;
        if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (document.status !== "issued") {
          throw new DomainError("CONFLICT", "発行済みの文書にだけ実績を結びつけられます");
        }

        const rows = await client.query(
          `SELECT id, status, document_id FROM condition_events
            WHERE id = ANY($1::bigint[]) AND condition_id = $2`, [ids, conditionId]);
        const found = rows.rows as Array<{ id: number; status: string; document_id: number | null }>;
        if (found.length !== ids.length) {
          throw new DomainError("NOT_FOUND", "この条件に無い実績が混ざっています");
        }
        const voided = found.filter((r) => r.status !== "active");
        if (voided.length) {
          throw new DomainError("CONFLICT",
            `取り消し済みの実績は結びつけられません（#${voided.map((r) => r.id).join("・")}）`);
        }
        // bigint は文字列で返る。数に揃えないと "7" !== 7 で、この文書自身が
        // 結んだ実績まで「別の文書のもの」と読んでしまう
        // （訂正版の発行で実績を移したあと、ここで必ず弾かれていた）。
        const taken = found.filter((r) =>
          r.document_id !== null && Number(r.document_id) !== Number(documentId));
        if (taken.length) {
          throw new DomainError("CONFLICT",
            `すでに別の文書に結びついている実績があります（#${taken.map((r) => r.id).join("・")}）。` +
            "作り直すなら、先にその文書を無効にしてください");
        }

        const updated = await client.query(
          `UPDATE condition_events SET document_id = $3
            WHERE id = ANY($1::bigint[]) AND condition_id = $2 AND document_id IS NULL`,
          [ids, conditionId, documentId]);

        const linked = updated.rowCount ?? 0;
        // 何も動いていないなら記録しない。すでに全部この文書を指している
        // （訂正版の発行で移ってきた）ときに linked:0 の行が積もると、
        // 履歴を読む側が「結びつけに失敗した」と誤読する。
        if (linked) {
          await recordAudit(client, {
            actor, action: "condition.link_document", targetType: "condition",
            targetId: conditionId,
            detail: { documentId, documentNo: document.document_no, eventIds: ids, linked }
          });
        }
        return { linked, documentNo: document.document_no };
      });
    } catch (error) { throw translate(error); }
  }
}
